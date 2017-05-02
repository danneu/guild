/*
       TODO: Patch xbbcode.js so the library itself is compat with node
*/

// Boolean representing whether or not this file is being executed on the
// server or not. If false, we're on the browser.
var isServer = typeof window === 'undefined';
var isBrowser = typeof window !== 'undefined';

var cheerio, util, cache;
if (isServer) {
  // Node
  util = require('util');
  // 3rd party
  cheerio = require('cheerio');
  var Autolinker = require('autolinker');
  // 1st party
  cache = require('./cache');
}

function escapeHtml (unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

// String -> Maybe String
function extractYoutubeId(url) {
  var re = /^.*(?:youtu.be\/|v\/|e\/|u\/\w+\/|embed\/|v=)([^#\&\?]{11}).*/;
  var match = url.match(re);
  return match && match[1];
}

// This function is intended to prevent the Reply button from including
// nested quote contents.
//
// aaa
// [quote=outer]
// hello
// [quote=inner]
// :)
// [/quote]
// bye
// [/quote]
// zzz
//
// becomes...
//
// aaa
// <Snipped quote by outer>
// zzz
//
//
// Given a post's markup, it replaces nested quotes with
// <Snipped quote by {{ uname }}> or <Snipped quote>
// The returned string is then ready to be wrapped with [quote=@...][/quote]
// and placed in the editor
function extractTopLevelMarkup(markup) {
  var re = /\[(quote)=?@?([a-z0-9_\- ]+)?\]|\[(\/quote)\]/gi;
  // A quoteStack item is { idx: Int, uname: String | undefined }
  var quoteStack = [];

  // match[1] is 'quote' (opening quote tag)
  // match[2] is 'uname' of [quote=uname]. Only maybe present when match[1] exists
  // match[3] is '/quote' (closing quote)
  while(true) {
    var match = re.exec(markup);
    if (!match) {
      break;
    } else {
      if (match[1]) {
        // Open quote tag
        var uname = match[2]; // String | undefined
        quoteStack.push({ idx: match.index, uname: uname });
      } else if (match[3]) {
        // Close quote tag
        // - If there's only 1 quote on the quoteStack, we know this is a top-level
        //   quote that we want to replace with '<Snip>'
        // - If there are more than 1 quote on the stack, then just pop() and loop.
        //   Means we're in a nested quote.
        // - If quoteStack is empty just loop
        if (quoteStack.length > 1) {
          quoteStack.pop();
        } else if (quoteStack.length === 1) {
          //debug(match.input);
          var startIdx = quoteStack[0].idx;
          var endIdx = match.index + '[/quote]'.length;
          var quote = quoteStack.pop();
          var newMarkup = match.input.slice(0, startIdx) +
            (quote.uname ? '<Snipped quote by ' + quote.uname  + '>'
                         : '<Snipped quote>') +
            match.input.slice(endIdx);

          markup = newMarkup;
          re.lastIndex = re.lastIndex - (endIdx - startIdx);
        }
      }
    }
  }

  return markup;
}


// Keep in sync with BBCode cheatsheet
var smilies = [
  'airquotes',
  'airquote',
  'arghfist',
  'bow',
  'brow',
  'btw',
  'cool',
  'dreamy',
  'drool',
  'gray',
  'confused',
  'magnum',
  'nat',
  'hehe',
  'lol',
  'hmm',
  'golfclap',
  'ou',
  'newlol',
  'punch',
  'rock',
  'respek',
  'rollin',
  'rolleyes',
  'sick',
  'sun',
  'toot',
  'usa',
  'wub',
  'what',
  'zzz'
];
var smilieRegExp = new RegExp(':(' + smilies.join('|') + ')', 'ig');

function replaceSmilies(text) {
  return text.replace(smilieRegExp, '<img src="/smilies/$1.gif">');
}

var greenTextRegExp = /^((?:<[^>]+>)*)(&gt;\S.*)$/gm;
function replaceGreenText(text) {
  return text.replace(greenTextRegExp, '$1<span class="bb-greentext">$2</span>');
}

function replaceHr(text) {
  return text.replace(/&#91;hr&#93;/g, '<hr class="bb-hr">');
}

// Replace unames


function replaceMentions(text) {
  function slugifyUname(uname) {
      return uname.trim().toLowerCase().replace(/ /g, '-');
  }
  return text.replace(/\[@([a-z0-9_\- ]+)\]/ig, function(_, p1) {
    var uname = p1.trim();
    var path = '/users/' + slugifyUname(uname);
    if (isBrowser) {
      // If we're on the browser, just render anchor every time
      // TODO: Only render mentions in browser is uname exists in DB
      return '<a class="bb-mention" href="'+path+'">@' + uname + '</a>';
    } else {
      // If we're on the server, then only render anchor if uname exists in DB.
      var trie = cache.get('uname-regex-trie');
      if (trie.contains(uname.toLowerCase())) {
        return '<a class="bb-mention" href="'+path+'">@' + uname + '</a>';
      } else {
        return '[@' + uname + ']';
      }
    }
  });
}

var XBBCODE = (function() {

  ////
  //// Here are some nasty global variables that let me add in some stateful
  //// hacks until I have time to find better ways to do these things.
  ////
  //
  // Global tabIdx cursor so that [tab] context knows when it's first
  // in the array of [tabs] children.
  var tabIdx = 0;
  // Only true for the first [row] parsed within a [table]
  // This lets me wrap the first [row] with a <thead>
  var isFirstTableRow = true;
  // Global array of errors that will be concat'd to the errorQueue array at the
  // end. I use this to implement tag validation.
  var tagErrs = [];
  // A map of tagName -> Bool. openTag logic should set it to true if it
  // encounters validation error. closeTag logic should always set it back to false
  // right before it returns.
  // This allows openTag and closeTag to communicate an error state.
  var hasError = {};

  function generateUuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random()*16|0, v = c == 'x' ? r : (r&0x3|0x8);
      return v.toString(16);
    });
  }

  // -----------------------------------------------------------------------------
  // Set up private variables
  // -----------------------------------------------------------------------------

  var me = {},
  // This library's default:
  //urlPattern = /^[-a-z0-9:;@#%&()~_?\+=\/\\\.]+$/i,

  // https://mathiasbynens.be/demo/url-regex
  // Source from https://gist.github.com/dperini/729294
  urlPattern = new RegExp(
    "^" +
      // protocol identifier
      "(?:(?:https?|ftp)://)" +
      // user:pass authentication
      "(?:\\S+(?::\\S*)?@)?" +
      "(?:" +
        // IP address exclusion
        // private & local networks
        "(?!(?:10|127)(?:\\.\\d{1,3}){3})" +
        "(?!(?:169\\.254|192\\.168)(?:\\.\\d{1,3}){2})" +
        "(?!172\\.(?:1[6-9]|2\\d|3[0-1])(?:\\.\\d{1,3}){2})" +
        // IP address dotted notation octets
        // excludes loopback network 0.0.0.0
        // excludes reserved space >= 224.0.0.0
        // excludes network & broacast addresses
        // (first & last IP address of each class)
        "(?:[1-9]\\d?|1\\d\\d|2[01]\\d|22[0-3])" +
        "(?:\\.(?:1?\\d{1,2}|2[0-4]\\d|25[0-5])){2}" +
        "(?:\\.(?:[1-9]\\d?|1\\d\\d|2[0-4]\\d|25[0-4]))" +
      "|" +
        // host name
        "(?:(?:[a-z\\u00a1-\\uffff0-9]-*)*[a-z\\u00a1-\\uffff0-9]+)" +
        // domain name
        "(?:\\.(?:[a-z\\u00a1-\\uffff0-9]-*)*[a-z\\u00a1-\\uffff0-9]+)*" +
        // TLD identifier
        "(?:\\.(?:[a-z\\u00a1-\\uffff]{2,}))" +
      ")" +
      // port number
      "(?::\\d{2,5})?" +
      // resource path
      "(?:/\\S*)?" +
    "$", "i"
  ),
  colorNamePattern = /^(?:aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|green|greenyellow|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgreen|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen)$/,
  colorCodePattern = /^#?[a-fA-F0-9]{6}$/,
  emailPattern = /[^\s@]+@[^\s@]+\.[^\s@]+/,
  fontFacePattern = /^([a-z][a-z0-9_]+|"[a-z][a-z0-9_\s]+")$/i,
  tags,
  tagList,
  tagsNoParseList = [],
  bbRegExp,
  pbbRegExp,
  pbbRegExp2,
  openTags,
  closeTags;

  /* -----------------------------------------------------------------------------
   * tags
   * This object contains a list of tags that your code will be able to understand.
   * Each tag object has the following properties:
   *
   *   openTag - A function that takes in the tag's parameters (if any) and its
   *             contents, and returns what its HTML open tag should be.
   *             Example: [color=red]test[/color] would take in "=red" as a
   *             parameter input, and "test" as a content input.
   *             It should be noted that any BBCode inside of "content" will have
   *             been processed by the time it enter the openTag function.
   *
   *   closeTag - A function that takes in the tag's parameters (if any) and its
   *              contents, and returns what its HTML close tag should be.
   *
   *   displayContent - Defaults to true. If false, the content for the tag will
   *                    not be displayed. This is useful for tags like IMG where
   *                    its contents are actually a parameter input.
   *
   *   restrictChildrenTo - A list of BBCode tags which are allowed to be nested
   *                        within this BBCode tag. If this property is omitted,
   *                        any BBCode tag may be nested within the tag.
   *
   *   restrictParentsTo - A list of BBCode tags which are allowed to be parents of
   *                       this BBCode tag. If this property is omitted, any BBCode
   *                       tag may be a parent of the tag.
   *
   *   noParse - true or false. If true, none of the content WITHIN this tag will be
   *             parsed by the XBBCode parser.
   *
   *
   *
   * LIMITIONS on adding NEW TAGS:
   *  - Tag names should be alphanumeric (including underscores) and all tags should have an opening tag
   *    and a closing tag.
   *    The [*] tag is an exception because it was already a standard
   *    bbcode tag. Technecially tags don't *have* to be alphanumeric, but since
   *    regular expressions are used to parse the text, if you use a non-alphanumeric
   *    tag names, just make sure the tag name gets escaped properly (if needed).
   * --------------------------------------------------------------------------- */

  // Extracting BBCode implementations makes it simpler to create aliases
  // like color & colour -> colorSpec
  var colorSpec = {
    openTag: function(params,content) {

      // Ensure they gave us a colorCode
      if (!params) {
        tagErrs.push('You have a COLOR tag that does not specify a color');
        hasError.color = true;
        return '&#91;color&#93;';
      }

      // Ensure there's actually content
      if (content.trim().length === 0) {
        tagErrs.push('You have a COLOR tag with no contents');
        hasError.color = true;
        return '&#91;color'+params+'&#93;';
      }

      var colorCode = (params.substr(1)).toLowerCase();

      // Ensure colorCode is actually a color
      // TODO: Look up why library sets lastIndex to 0. Roll with it for now.
      colorNamePattern.lastIndex = 0;
      colorCodePattern.lastIndex = 0;
      if (!colorNamePattern.test(colorCode) && !colorCodePattern.test(colorCode)) {
        hasError.color = true;
        tagErrs.push('You have a COLOR tag with an invalid color: '+
                     '[color'+ params +']');
        return '&#91;color'+params+'&#93;';
      }

      // If colorCode is a hex value, prefix it with # if it's missing
      colorCodePattern.lastIndex = 0;
      if (colorCodePattern.test(colorCode) && colorCode.substr(0,1) !== "#") {
        colorCode = "#" + colorCode;
      }

      return '<font color="' + colorCode + '">';
    },
    closeTag: function(params,content) {
      var ret = hasError.color ? '&#91;/color&#93;' : '</font>';
      hasError.color = false;
      return ret;
    }
  };

  var centerSpec = {
    trimContents: true,
    openTag: function(params,content) {
      return '<div class="bb-center">';
    },
    closeTag: function(params,content) {
      return '</div>';
    }
  };

  tags = {
    //
    // Custom BBCode for the Guild
    //
    "hider": {
      trimContents: true,
      openTag: function(params, content) {
        var title = params ? escapeHtml(params.slice(1)) : 'Hider';
        return '<div class="hider-panel">'+
          '<div class="hider-heading">'+
          '<button type="button" class="btn btn-default btn-xs hider-button" data-name="'+title+'">'+
          // title + ' [+]'+
          // Must use html entity code for brackets so i dont trip
          // the "there appears to be misaligned tags" err.
          title + ' &#91;+&#93;'+
          '</button>'+
          '</div>'+
          '<div class="hider-body" style="display: none">';
      },
      closeTag: function(params, content) {
        return '</div></div>';
      }
    },
    "youtube": {
      displayContent: false,
      openTag: function(params, content) {
        var youtubeId = extractYoutubeId(content);
        if (!youtubeId)
          return '&#91;youtube&#93;' + content +'&#91;/youtube&#93;';
        var src = '//youtube.com/embed/' + youtubeId + '?theme=dark';
        return '<iframe src="'+src+'" frameborder="0" width="496" height="279" allowfullscreen></iframe>';
      },
      closeTag: function(params, content) {
        return '';
      }
    },
    "abbr": {
      openTag: function(params, content) {

        return '<abbr class="bb-abbr" title="'+(params && params.slice(1))+'">';
      },
      closeTag: function(params, content) {
        return '</abbr>';
      }
    },
    "code": {
      noParse: true,
      trimContents: true,
      openTag: function(params, content) {

        return '<code>';
      },
      closeTag: function(params, content) {
        return '</code>';
      }
    },
    "pre": {
      noParse: true,
      trimContents: true,
      openTag: function(params, content) {

        return '<pre>';
      },
      closeTag: function(params, content) {
        return '</pre>';
      }
    },
    "mark": {
      openTag: function(params, content) {
        return '<span class="bb-mark">';
      },
      closeTag: function(params, content) {
        return '</span>';
      }
    },
    "indent": {
      trimContents: true,
      openTag: function(params, content) {
        return '<div class="bb-indent">';
      },
      closeTag: function(params, content) {
        return '</div>';
      }
    },
    "h1": {
      trimContents: true,
      openTag: function(params, content) {
        return '<div class="bb-h1">';
      },
      closeTag: function(params, content) {
        return '</div>';
      }
    },
    "h2": {
      trimContents: true,
      openTag: function(params, content) {
        return '<div class="bb-h2">';
      },
      closeTag: function(params, content) {
        return '</div>';
      }
    },
    "h3": {
      trimContents: true,
      openTag: function(params, content) {
        return '<div class="bb-h3">';
      },
      closeTag: function(params, content) {
        return '</div>';
      }
    },

    ////
    //// Tabs are temporarily disabled until fixed
    ////

    // "tabs": {
    //   restrictChildrenTo: ["tab"],
    //   openTag: function(params, content) {
    //     var html = '<div role="tabpanel" style="white-space: normal">';
    //     html = html + '<ul class="nav nav-tabs" role="tablist">';

    //     // This is what we're gonna loop through
    //     // We just build it differently on server vs the client
    //     var $coll;

    //     if (typeof window === 'undefined') {
    //       // In Node, $ won't exist
    //       var $ = cheerio.load(content);
    //       $coll = $('div[data-title]');
    //     } else {
    //       // In JS, $ will exist
    //       $coll = $('<div></div>').append(content).find('div[data-title]');
    //     }

    //     // var $ = cheerio.load(content);
    //     // $('div[data-title]').each(function(idx) {
    //     //$('<div></div>').append(content).find('div[data-title]').each(function(idx) {
    //     $coll.each(function(idx) {
    //       var title = $(this).attr('data-title');
    //       var id = $(this).attr('id');
    //       if (idx===0) {
    //         $(this).addClass('active');
    //       }
    //       html = html + '<li'+ (idx===0 ? ' class="active"' : '') +'><a href="#'+id+'" data-toggle="tab">' + title + '</a></li>';
    //     });
    //     html = html + '</ul>';
    //     html = html + '<div class="tab-content tabbed-content">';
    //     return html;
    //   },
    //   closeTag: function(params, content) {
    //     tabIdx = 0;
    //     return '</div></div>';
    //   }
    // },

    // "tab": {
    //   restrictParentsTo: ['tabs'],
    //   openTag: function(params, content) {
    //     var title = params ? params.slice(1) : 'Tab';
    //     var uuid = generateUuid();
    //     return '<div role="tabpanel" style="white-space: pre-line" class="tab-pane' + (tabIdx++===0 ? ' active' : '') +'" id="'+uuid+'" data-title="' + title + '">';
    //   },
    //   closeTag: function(params, content) {
    //     return '</div>';
    //   }
    // },
    //
    // BBCode that shipped with XBBCODE library
    //

    "b": {
      openTag: function(params,content) {
        return '<span class="bb-b">';
      },
      closeTag: function(params,content) {
        return '</span>';
      }
    },
    /*
      This tag does nothing and is here mostly to be used as a classification for
      the bbcode input when evaluating parent-child tag relationships
    */
    "bbcode": {
      openTag: function(params,content) {
        return '';
      },
      closeTag: function(params,content) {
        return '';
      }
    },
    "center": centerSpec,
    "centre": centerSpec,
    // "code": {
    //   openTag: function(params,content) {
    //     return '<pre>';
    //   },
    //   closeTag: function(params,content) {
    //     return '</pre>';
    //   },
    //   noParse: true
    // },
    "color": colorSpec,
    "colour": colorSpec,
    // "email": {
    //   openTag: function(params,content) {

    //     var myEmail;

    //     if (!params) {
    //       myEmail = content.replace(/<.*?>/g,"");
    //     } else {
    //       myEmail = params.substr(1);
    //     }

    //     emailPattern.lastIndex = 0;
    //     if ( !emailPattern.test( myEmail ) ) {
    //       return '<a>';
    //     }

    //     return '<a href="mailto:' + myEmail + '">';
    //   },
    //   closeTag: function(params,content) {
    //     return '</a>';
    //   }
    // },
    // "face": {
    //   openTag: function(params,content) {

    //     var faceCode = params.substr(1) || "inherit";
    //     fontFacePattern.lastIndex = 0;
    //     if ( !fontFacePattern.test( faceCode ) ) {
    //       faceCode = "inherit";
    //     }
    //     return '<span style="font-family:' + faceCode + '">';
    //   },
    //   closeTag: function(params,content) {
    //     return '</span>';
    //   }
    // },
    // "font": {
    //   openTag: function(params,content) {

    //     var faceCode = params.substr(1) || "inherit";
    //     fontFacePattern.lastIndex = 0;
    //     if ( !fontFacePattern.test( faceCode ) ) {
    //       faceCode = "inherit";
    //     }
    //     return '<span style="font-family:' + faceCode + '">';
    //   },
    //   closeTag: function(params,content) {
    //     return '</span>';
    //   }
    // },
    "i": {
      openTag: function(params,content) {
        return '<span class="bb-i">';
      },
      closeTag: function(params,content) {
        return '</span>';
      }
    },
    "img": {
      openTag: function(params,content) {

        var myUrl = content.trim();

        urlPattern.lastIndex = 0;
        if ( !urlPattern.test( myUrl ) ) {
          myUrl = "";
        }

        return '<img src="' + myUrl + '" />';
      },
      closeTag: function(params,content) {
        return '';
      },
      displayContent: false
    },
    "justify": {
      trimContents: true,
      openTag: function(params,content) {
        return '<span class="bb-justify">';
      },
      closeTag: function(params,content) {
        return '</span>';
      }
    },
    // "large": {
    //   openTag: function(params,content) {
		// 		var params = params || '';
		// 		var colorCode = params.substr(1) || "inherit";
    //     colorNamePattern.lastIndex = 0;
    //     colorCodePattern.lastIndex = 0;
    //     if ( !colorNamePattern.test( colorCode ) ) {
    //       if ( !colorCodePattern.test( colorCode ) ) {
    //         colorCode = "inherit";
    //       } else {
    //         if (colorCode.substr(0,1) !== "#") {
    //           colorCode = "#" + colorCode;
    //         }
    //       }
    //     }
    //     return '<span class="xbbcode-size-36" style="color:' + colorCode + '">';
    //   },
    //   closeTag: function(params,content) {
    //     return '</span>';
    //   }
    // },
    // "left": {
    //   openTag: function(params,content) {
    //     return '<div class="bb-left">';
    //   },
    //   closeTag: function(params,content) {
    //     return '</div>';
    //   }
    // },
    // "li": {
    //   openTag: function(params,content) {
    //     return '<li style="white-space: pre-line;">';
    //   },
    //   closeTag: function(params,content) {
    //     return "</li>";
    //   },
    //   restrictParentsTo: ["list","ul","ol"]
    // },
    "list": {
      openTag: function(params,content) {
        return '<ul class="bb-list" style="white-space: normal;">';
      },
      closeTag: function(params,content) {
        return '</ul>';
      },
      restrictChildrenTo: ["*", "li"]
    },
    "noparse": {
      openTag: function(params,content) {
        return '';
      },
      closeTag: function(params,content) {
        return '';
      },
      noParse: true
    },
    // "ol": {
    //   openTag: function(params,content) {
    //     return '<ol style="white-space: normal">';
    //   },
    //   closeTag: function(params,content) {
    //     return '</ol>';
    //   },
    //   restrictChildrenTo: ["*", "li"]
    // },
    // "php": {
    //   openTag: function(params,content) {
    //     return '<span class="xbbcode-code">';
    //   },
    //   closeTag: function(params,content) {
    //     return '</span>';
    //   },
    //   noParse: true
    // },
    "quote": {
      trimContents: true,
      openTag: function(params,content) {
        return '<blockquote class="bb-quote">';
      },
      closeTag: function(params,content) {
        var html = '';
        if (params) {
          // params starts with '=' unless user messed up.
          // e.g. '=@Mahz' or '=some guy'
          if (params.slice(1).charAt(0) === '@' && params.slice(1).length > 1) {
            // This is a @uname mention
            var uname = params.slice(2);
            html += '<footer>&#91;@' + uname + '&#93;</footer>';
          } else {
            var source = params.slice(1);
            html += '<footer>' + source + '</footer>';
          }
        }
        html = html + '</blockquote>';
        return html;
      }
    },
    "right": {
      trimContents: true,
      openTag: function(params,content) {
        return '<div class="bb-right">';
      },
      closeTag: function(params,content) {
        return '</div>';
      }
    },
    "s": {
      openTag: function(params,content) {
        return '<span class="bb-s">';
      },
      closeTag: function(params,content) {
        return '</span>';
      }
    },
    // "size": {
    //   openTag: function(params,content) {

    //     var mySize = parseInt(params.substr(1),10) || 0;
    //     if (mySize < 4 || mySize > 40) {
    //       mySize = 14;
    //     }

    //     return '<span class="xbbcode-size-' + mySize + '">';
    //   },
    //   closeTag: function(params,content) {
    //     return '</span>';
    //   }
    // },
    // "small": {
    //   openTag: function(params,content) {
		// 		var params = params || '';
		// 		var colorCode = params.substr(1) || "inherit";
    //     colorNamePattern.lastIndex = 0;
    //     colorCodePattern.lastIndex = 0;
    //     if ( !colorNamePattern.test( colorCode ) ) {
    //       if ( !colorCodePattern.test( colorCode ) ) {
    //         colorCode = "inherit";
    //       } else {
    //         if (colorCode.substr(0,1) !== "#") {
    //           colorCode = "#" + colorCode;
    //         }
    //       }
    //     }

    //     return '<span class="xbbcode-size-10" style="color:' + colorCode + '">';
    //   },
    //   closeTag: function(params,content) {
    //     return '</span>';
    //   }
    // },
    "sub": {
      openTag: function(params,content) {
        return '<sub>';
      },
      closeTag: function(params,content) {
        return '</sub>';
      }
    },
    "sup": {
      openTag: function(params,content) {
        return '<sup>';
      },
      closeTag: function(params,content) {
        return '</sup>';
      }
    },
    "table": {
      openTag: function(params,content) {
        if (params && params.slice(1) === 'bordered')
          return '<div class="table-responsive"><table class="bb-table table table-bordered">';
        return '<div class="table-responsive"><table class="bb-table table">';
      },
      closeTag: function(params,content) {
        isFirstTableRow = true;
        return '</table></div>';
      },
      // restrictChildrenTo: ["tbody","thead", "tfoot", "tr"]
      restrictChildrenTo: ["row"]
    },
    // "tbody": {
    //   openTag: function(params,content) {
    //     return '<tbody>';
    //   },
    //   closeTag: function(params,content) {
    //     return '</tbody>';
    //   },
    //   restrictChildrenTo: ["tr"],
    //   restrictParentsTo: ["table"]
    // },
    // "tfoot": {
    //   openTag: function(params,content) {
    //     return '<tfoot class="bb-tfoot">';
    //   },
    //   closeTag: function(params,content) {
    //     return '</tfoot>';
    //   },
    //   restrictChildrenTo: ["tr"],
    //   restrictParentsTo: ["table"]
    // },
    // "thead": {
    //   openTag: function(params,content) {
    //     return '<thead class="bb-thead">';
    //   },
    //   closeTag: function(params,content) {
    //     return '</thead>';
    //   },
    //   restrictChildrenTo: ["tr"],
    //   restrictParentsTo: ["table"]
    // },
    "cell": {
      openTag: function(params,content) {
        if (isFirstTableRow)
          return '<th class="bb-th">';

        var classNames = [''], status;
        // Determine the status if one is given.
        switch(params && params.slice(1)) {
          case 'active': status = 'active'; break;
          case 'success': status = 'success'; break;
          case 'warning': status = 'warning'; break;
          case 'danger': status = 'danger'; break;
          case 'info': status = 'info'; break;
          default: break;
        }
        classNames.push('bb-td');
        if (status)
          classNames = classNames.concat([status, 'bb-' + status]);
        return '<td class="'+classNames.join(' ')+'">';
      },
      closeTag: function(params,content) {
        if (isFirstTableRow)
          return '</th>';
        return '</td>';
      },
      restrictParentsTo: ["row"]
    },
    // "th": {
    //   openTag: function(params,content) {
    //     return '<th class="bb-th">';
    //   },
    //   closeTag: function(params,content) {
    //     return '</th>';
    //   },
    //   restrictParentsTo: ["tr"]
    // },
    "row": {
      openTag: function(params,content) {
        if (isFirstTableRow) {
          return '<thead class="bb-thead"><tr class="bb-tr">';
        }

        var classNames = [''], status;
        // Determine the status if one is given.
        switch(params && params.slice(1)) {
          case 'active': status = 'active'; break;
          case 'success': status = 'success'; break;
          case 'warning': status = 'warning'; break;
          case 'danger': status = 'danger'; break;
          case 'info': status = 'info'; break;
          default: break;
        }
        classNames.push('bb-tr');
        if (status)
          classNames = classNames.concat([status, 'bb-' + status]);
        return '<tr class="'+classNames.join(' ')+'">';
      },
      closeTag: function(params,content) {
        var html;
        if (isFirstTableRow)
          html = '</tr></thead>';
        else
          html = '</tr>';
        isFirstTableRow = false;
        return html;
      },
      restrictChildrenTo: ["cell"],
      restrictParentsTo: ["table"]
    },
    "u": {
      openTag: function(params,content) {
        return '<span class="bb-u">';
      },
      closeTag: function(params,content) {
        return '</span>';
      }
    },
    // "ul": {
    //   openTag: function(params,content) {
    //     return '<ul>';
    //   },
    //   closeTag: function(params,content) {
    //     return '</ul>';
    //   },
    //   restrictChildrenTo: ["*", "li"]
    // },
    "url": {
      trimContents: true,
      openTag: function(params,content) {

        var myUrl;

        if (!params) {
          myUrl = content.trim().replace(/<.*?>/g,"");
        } else {
          myUrl = params.trim().substr(1).trim();
        }

        if (myUrl.indexOf('http') !== 0 && myUrl.indexOf('ftp://') !== 0){
          // they don't have a valid protocol at the start, so add one [#63]
          myUrl = 'http://' + myUrl;
        }

        urlPattern.lastIndex = 0;
        if ( !urlPattern.test( myUrl ) ) {
          hasError.url = true;
          tagErrs.push('One of your [url] tags has an invalid url');
          if (params)
            return '&#91;url='+ myUrl + '&#93;';
          else
            return '&#91;url&#93;';
        }


        // dumb way to see if user is linking internally or externally
        // keep synced with Autolinker#replaceFn definedin this file
        if (/roleplayerguild.com/i.test(myUrl)) {
          // internal link
          return '<a href="' + myUrl + '">';
        } else {
          // external link
          return '<a target="_blank" rel="nofollow noopener" href="' + myUrl + '">';
        }
      },
      closeTag: function(params,content) {
        var ret = hasError.url ? '&#91;/url&#93;' : '</a>';
        hasError.url = false;
        return ret;
      }
    },
    /*
      The [*] tag is special since the user does not define a closing [/*] tag when writing their bbcode.
      Instead this module parses the code and adds the closing [/*] tag in for them. None of the tags you
      add will act like this and this tag is an exception to the others.
    */
    "*": {
      trimContents: true,
      openTag: function(params,content) {
        return "<li>";
      },
      closeTag: function(params,content) {
        return "</li>";
      },
      restrictParentsTo: ["list","ul","ol"]
    }
  };

  // create tag list and lookup fields
  function initTags() {
    tagList = [];
    var prop, ii, len;
    for (prop in tags) {
      if (tags.hasOwnProperty(prop)) {
        if (prop === "*") {
          tagList.push("\\" + prop);
        } else {
          tagList.push(prop);
          if ( tags[prop].noParse ) {
            tagsNoParseList.push(prop);
          }
        }

        tags[prop].validChildLookup = {};
        tags[prop].validParentLookup = {};
        tags[prop].restrictParentsTo = tags[prop].restrictParentsTo || [];
        tags[prop].restrictChildrenTo = tags[prop].restrictChildrenTo || [];

        len = tags[prop].restrictChildrenTo.length;
        for (ii = 0; ii < len; ii++) {
          tags[prop].validChildLookup[ tags[prop].restrictChildrenTo[ii] ] = true;
        }
        len = tags[prop].restrictParentsTo.length;
        for (ii = 0; ii < len; ii++) {
          tags[prop].validParentLookup[ tags[prop].restrictParentsTo[ii] ] = true;
        }
      }
    }

    bbRegExp = new RegExp("<bbcl=([0-9]+) (" + tagList.join("|") + ")([ =][^>]*?)?>((?:.|[\\r\\n])*?)<bbcl=\\1 /\\2>", "gi");
    pbbRegExp = new RegExp("\\[(" + tagList.join("|") + ")([ =][^\\]]*?)?\\]([^\\[]*?)\\[/\\1\\]", "gi");
    pbbRegExp2 = new RegExp("\\[(" + tagsNoParseList.join("|") + ")([ =][^\\]]*?)?\\]([\\s\\S]*?)\\[/\\1\\]", "gi");

    // create the regex for escaping ['s that aren't apart of tags
    (function() {
      var closeTagList = [];
      for (var ii = 0; ii < tagList.length; ii++) {
        if ( tagList[ii] !== "\\*" ) { // the * tag doesn't have an offical closing tag
          closeTagList.push ( "/" + tagList[ii] );
        }
      }

      openTags = new RegExp("(\\[)((?:" + tagList.join("|") + ")(?:[ =][^\\]]*?)?)(\\])", "gi");
      closeTags = new RegExp("(\\[)(" + closeTagList.join("|") + ")(\\])", "gi");
    })();

  };
  initTags();

  // -----------------------------------------------------------------------------
  // private functions
  // -----------------------------------------------------------------------------

  function checkParentChildRestrictions(parentTag, bbcode, bbcodeLevel, tagName, tagParams, tagContents, errQueue) {

    errQueue = errQueue || [];
    bbcodeLevel++;

    // get a list of all of the child tags to this tag
    var reTagNames = new RegExp("(<bbcl=" + bbcodeLevel + " )(" + tagList.join("|") + ")([ =>])","gi"),
    reTagNamesParts = new RegExp("(<bbcl=" + bbcodeLevel + " )(" + tagList.join("|") + ")([ =>])","i"),
    matchingTags = tagContents.match(reTagNames) || [],
    cInfo,
    errStr,
    ii,
    childTag,
    pInfo = tags[parentTag] || {};

    reTagNames.lastIndex = 0;

    if (!matchingTags) {
      tagContents = "";
    }

    for (ii = 0; ii < matchingTags.length; ii++) {
      reTagNamesParts.lastIndex = 0;
      childTag = (matchingTags[ii].match(reTagNamesParts))[2].toLowerCase();

      if ( pInfo && pInfo.restrictChildrenTo && pInfo.restrictChildrenTo.length > 0 ) {
        if ( !pInfo.validChildLookup[childTag] ) {
          errStr = "The tag \"" + childTag + "\" is not allowed as a child of the tag \"" + parentTag + "\".";
          errQueue.push(errStr);
        }
      }
      cInfo = tags[childTag] || {};
      if ( cInfo.restrictParentsTo.length > 0 ) {
        if ( !cInfo.validParentLookup[parentTag] ) {
          errStr = "The tag \"" + parentTag + "\" is not allowed as a parent of the tag \"" + childTag + "\".";
          errQueue.push(errStr);
        }
      }

    }

    tagContents = tagContents.replace(bbRegExp, function(matchStr, bbcodeLevel, tagName, tagParams, tagContents ) {
      errQueue = checkParentChildRestrictions(tagName.toLowerCase(), matchStr, bbcodeLevel, tagName, tagParams, tagContents, errQueue);
      return matchStr;
    });
    return errQueue;
  }

  /*
    This function updates or adds a piece of metadata to each tag called "bbcl" which
    indicates how deeply nested a particular tag was in the bbcode. This property is removed
    from the HTML code tags at the end of the processing.
  */
  function updateTagDepths(tagContents) {
    tagContents = tagContents.replace(/\<([^\>][^\>]*?)\>/gi, function(matchStr, subMatchStr) {
      var bbCodeLevel = subMatchStr.match(/^bbcl=([0-9]+) /);
      if (bbCodeLevel === null) {
        return "<bbcl=0 " + subMatchStr + ">";
      } else {
        return "<" + subMatchStr.replace(/^(bbcl=)([0-9]+)/, function(matchStr, m1, m2) {
          return m1 + (parseInt(m2, 10) + 1);
        }) + ">";
      }
    });
    return tagContents;
  }

  /*
    This function removes the metadata added by the updateTagDepths function
  */
  function unprocess(tagContent) {
    return tagContent.replace(/<bbcl=[0-9]+ \/\*>/gi,"").replace(/<bbcl=[0-9]+ /gi,"&#91;").replace(/>/gi,"&#93;");
  }

  var replaceFunct = function(matchStr, bbcodeLevel, tagName, tagParams, tagContents) {

    tagName = tagName.toLowerCase();

    var processedContent = tags[tagName].noParse ? unprocess(tagContents) : tagContents.replace(bbRegExp, replaceFunct),
    openTag = tags[tagName].openTag(tagParams,processedContent),
    closeTag = tags[tagName].closeTag(tagParams,processedContent);

    if ( tags[tagName].displayContent === false) {
      processedContent = "";
    }

    if (tags[tagName].trimContents) {
      processedContent = processedContent.trim();
    }

    return openTag + processedContent.replace(/^\n+/, '').replace(/\n+$/, '') + closeTag;
  };

  function parse(config) {
    var output = config.text;
    output = output.replace(bbRegExp, replaceFunct);
    return output;
  }

  /*
    The star tag [*] is special in that it does not use a closing tag. Since this parser requires that tags to have a closing
    tag, we must pre-process the input and add in closing tags [/*] for the star tag.
    We have a little levaridge in that we know the text we're processing wont contain the <> characters (they have been
    changed into their HTML entity form to prevent XSS and code injection), so we can use those characters as markers to
    help us define boundaries and figure out where to place the [/*] tags.
  */
  function fixStarTag(text) {
    text = text.replace(/\[(?!\*[ =\]]|list([ =][^\]]*)?\]|\/list[\]])/ig, "<");
    text = text.replace(/\[(?=list([ =][^\]]*)?\]|\/list[\]])/ig, ">");

    while (text !== (text = text.replace(/>list([ =][^\]]*)?\]([^>]*?)(>\/list])/gi, function(matchStr,contents,endTag) {

      var innerListTxt = matchStr;
      while (innerListTxt !== (innerListTxt = innerListTxt.replace(/\[\*\]([^\[]*?)(\[\*\]|>\/list])/i, function(matchStr,contents,endTag) {
        if (endTag.toLowerCase() === ">/list]") {
          endTag = "</*]</list]";
        } else {
          endTag = "</*][*]";
        }
        return "<*]" + contents + endTag;
      })));

      innerListTxt = innerListTxt.replace(/>/g, "<");
      return innerListTxt;
    })));

    // add ['s for our tags back in
    text = text.replace(/</g, "[");
    return text;
  }

  function addBbcodeLevels(text) {
    while ( text !== (text = text.replace(pbbRegExp, function(matchStr, tagName, tagParams, tagContents) {
      matchStr = matchStr.replace(/\[/g, "<");
      matchStr = matchStr.replace(/\]/g, ">");
      return updateTagDepths(matchStr);
    })) );
    return text;
  }

  // -----------------------------------------------------------------------------
  // public functions
  // -----------------------------------------------------------------------------

  // API, Expose all available tags
  me.tags = function() {
    return tags;
  };

  // API
  me.addTags = function(newtags) {
    var tag;
    for (tag in newtags) {
      tags[tag] = newtags[tag];
    }
    initTags();
  };

  me.process = function(config) {

    var ret = {html: "", error: false},
    errQueue = [];

    config.text = config.text.replace(/</g, "&lt;"); // escape HTML tag brackets
    config.text = config.text.replace(/>/g, "&gt;"); // escape HTML tag brackets

    config.text = config.text.replace(openTags, function(matchStr, openB, contents, closeB) {
      return "<" + contents + ">";
    });
    config.text = config.text.replace(closeTags, function(matchStr, openB, contents, closeB) {
      return "<" + contents + ">";
    });

    config.text = config.text.replace(/\[/g, "&#91;"); // escape ['s that aren't apart of tags
    config.text = config.text.replace(/\]/g, "&#93;"); // escape ['s that aren't apart of tags
    config.text = config.text.replace(/</g, "["); // escape ['s that aren't apart of tags
    config.text = config.text.replace(/>/g, "]"); // escape ['s that aren't apart of tags

    // process tags that don't have their content parsed
    while ( config.text !== (config.text = config.text.replace(pbbRegExp2, function(matchStr, tagName, tagParams, tagContents) {
      tagContents = tagContents.replace(/\[/g, "&#91;");
      tagContents = tagContents.replace(/\]/g, "&#93;");
      tagParams = tagParams || "";
      tagContents = tagContents || "";
      return "[" + tagName + tagParams + "]" + tagContents + "[/" + tagName + "]";
    })) );

    config.text = fixStarTag(config.text); // add in closing tags for the [*] tag
    config.text = addBbcodeLevels(config.text); // add in level metadata

    errQueue = checkParentChildRestrictions("bbcode", config.text, -1, "", "", config.text);

    ret.html = parse(config);

    // Replace [hr] with <hr>
    ret.html = replaceHr(ret.html);

    // Wrap >greentext with styling
    ret.html = replaceGreenText(ret.html);

    if ( ret.html.indexOf("[") !== -1 || ret.html.indexOf("]") !== -1) {
      errQueue.push("Some tags appear to be misaligned.");
    }

    if (config.removeMisalignedTags) {
      ret.html = ret.html.replace(/\[.*?\]/g,"");
    }
    if (config.addInLineBreaks) {
      ret.html = '<div style="white-space:pre-wrap;">' + ret.html + '</div>';
    }

    // ret.html = ret.html.replace("&#91;", "["); // put ['s back in
    // ret.html = ret.html.replace("&#93;", "]"); // put ['s back in
    // Needed to patch above 2 lines of library code to replace all instances
    ret.html = ret.html.replace(/&#91;/g, '[').replace(/&#93;/g, ']');

    // Replace smilie codes with <img>s
    ret.html = replaceSmilies(ret.html);

    // Replace [@Mentions] with a link
    ret.html = replaceMentions(ret.html);

    ret.html = ret.html.replace(/\t/g,'&#9;');
    ret.html = ret.html.replace(/\r/g, '');
    ret.html = ret.html.replace(/\n{2,}/g, '\n\n');
    ret.html = ret.html.replace(/\n/g, '<br>');

    // concat tagErrs into errQueue at the last second
    // and then reset it for next run.
    errQueue = errQueue.concat(tagErrs);
    tagErrs = [];

    ret.error = errQueue.length !== 0;
    ret.errorQueue = errQueue;

    return ret;
  };

  return me;
})();

var autolinkerOpts = {
  stripPrefix: true,
  truncate: 40,
  email: false,
  phone: false,
  twitter: false,
  hashtag: false,
  newWindow: false,
  // keep synced with [url] logic
  replaceFn: function (autolinker, match) {
    //var tag = autolinker.getTagBuilder().build(match);
    var tag = match.buildTag();
    // dumb way to see if user is linking internally or externally
    if (!/roleplayerguild.com/i.test(match.getAnchorHref())) {
      tag.setAttr('rel', 'nofollow noopener').setAttr('target', '_blank');
    }
    return tag;
  }
};

// Allow bbcode_editor.js to access it
if (isBrowser) {
  window.autolinkerOpts = autolinkerOpts;
}

if (typeof window === 'undefined') {
  // We're on the server, so export module
  module.exports = function(markup) {
    var result, start = Date.now();
    result = XBBCODE.process({ text: markup, addInLineBreaks: true });
    // Linkify URLs
    var html = Autolinker.link(result.html, autolinkerOpts);
    var diff = Date.now() - start;
    // console.log(util.format('[bbcode.js] Rendered %s chars of BBCode in %sms', markup.length, diff));
    // console.log('[bbcode.js] result.error:', result.error);
    // console.log('[bbcode.js] result.errorQueue',result.errorQueue);

    return html;
  };
} else {
  // We're on the client so export to window
  window.bbcode = function(markup) {
    var result = XBBCODE.process({ text: markup, addInLineBreaks: true });
    var html = Autolinker.link(result.html, autolinkerOpts);
    return html;
  };
}


/*
   The following comment block is the original license, though
   this file has been significantly modified/hacked from what
   it originally was.
*/

/*
  Copyright (C) 2011 Patrick Gillespie, http://patorjk.com/

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in
  all copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
  THE SOFTWARE.
*/
