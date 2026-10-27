// needs to be .js
/*
       TODO: Patch xbbcode.js so the library itself is compat with node
*/

// Boolean representing whether or not this file is being executed on the
// server or not. If false, we're on the browser.
var isServer = typeof window === "undefined";
var isBrowser = typeof window !== "undefined";

var util, cache3, userHtml, MarkupRejected;
if (isServer) {
  // Node
  util = require("util");
  // 3rd party
  var Autolinker = require("autolinker");
  // 1st party
  cache3 = require("./cache3").default;
  userHtml = require("./user_html");
  MarkupRejected = require("./markup_rejected").MarkupRejected;
}

// The most levels tags may nest. Past it the server refuses the markup and
// the preview shows its tags as text. The cap bounds a render's cost at about
// MAX_TAG_DEPTH passes over the text, and the depth of parse's recursion.
var MAX_TAG_DEPTH = 50;
var tooDeepMessage =
  "Tags are nested more than " +
  MAX_TAG_DEPTH +
  " levels deep. Unnest some tags and try again.";

// String -> Maybe String
function extractYoutubeId(url) {
  // A youtube id is always 11 of these characters. The id goes into the
  // iframe src, so nothing else may get through.
  var re = /^.*(?:youtu.be\/|v\/|e\/|u\/\w+\/|embed\/|v=)([A-Za-z0-9_-]{11}).*/;
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
  while (true) {
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
          var endIdx = match.index + "[/quote]".length;
          var quote = quoteStack.pop();
          var newMarkup =
            match.input.slice(0, startIdx) +
            (quote.uname
              ? "<Snipped quote by " + quote.uname + ">"
              : "<Snipped quote>") +
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
  "airquotes",
  "airquote",
  "arghfist",
  "bow",
  "brow",
  "btw",
  "cool",
  "dreamy",
  "drool",
  "gray",
  "confused",
  "magnum",
  "nat",
  "hehe",
  "lol",
  "hmm",
  "golfclap",
  "ou",
  "newlol",
  "punch",
  "rock",
  "respek",
  "rollin",
  "rolleyes",
  "sick",
  "sun",
  "toot",
  "usa",
  "wub",
  "what",
  "zzz",
];
var smilieRegExp = new RegExp(":(" + smilies.join("|") + ")", "ig");

function replaceSmilies(text) {
  return text.replace(smilieRegExp, '<img src="/smilies/$1.gif">');
}

var greenTextRegExp = /^((?:<[^>]+>)*)(&gt;\S.*)$/gm;
function replaceGreenText(text) {
  return text.replace(
    greenTextRegExp,
    '$1<span class="bb-greentext">$2</span>',
  );
}

function replaceHr(text) {
  return text.replace(/&#91;hr&#93;/g, '<hr class="bb-hr">');
}

// Replace unames

function replaceMentions(text) {
  function slugifyUname(uname) {
    return uname.trim().toLowerCase().replace(/ /g, "-");
  }
  return text.replace(/\[@([a-z0-9_\- ]+)\]/gi, function (_, p1) {
    var uname = p1.trim();
    var path = "/users/" + slugifyUname(uname);
    if (isBrowser) {
      // If we're on the browser, just render anchor every time
      // TODO: Only render mentions in browser is uname exists in DB
      return '<a class="bb-mention" href="' + path + '">@' + uname + "</a>";
    } else {
      // If we're on the server, then only render anchor if uname exists in DB.
      var unames = cache3.get("uname-set");
      if (unames.has(uname.toLowerCase())) {
        return '<a class="bb-mention" href="' + path + '">@' + uname + "</a>";
      } else {
        return "[@" + uname + "]";
      }
    }
  });
}

// Returns the href for text when it is an absolute http, https or ftp URL to
// a public host, else null. tags.url and tags.img check URLs only here. The
// WHATWG URL parser runs in time linear in the text. The regex it replaced
// backtracked quadratically on long runs, so one 150k-character post could
// block the event loop for about 36 s (finding 261026-0911-005).
// text is renderer text, so any & starts an entity that the browser decodes
// when it reads the attribute.
function parseSafeUrl(text) {
  // The parser drops tabs and newlines and encodes spaces, so without this
  // it would take URLs that hold whitespace.
  if (/\s/.test(text)) return null;
  // The parser also takes "http:x.com" and "http:/x.com".
  if (!/^(?:https?|ftp):\/\//i.test(text)) return null;
  var url;
  if (typeof URL.parse === "function") {
    // Returns null rather than throwing, which matters when one post holds
    // thousands of bad URLs.
    url = URL.parse(text);
  } else {
    try {
      url = new URL(text);
    } catch (err) {
      url = null;
    }
  }
  return url && isPublicHost(url.hostname) ? url.href : null;
}

// The parser has already lowercased the host, turned unicode labels into
// punycode, and rewritten any IPv4 form, such as 0x7f.1, as four decimal
// octets.
var ipv4Pattern = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/;
var hostLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
var topLabelPattern = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

// A host name of two or more labels, or a public IPv4 address. IPv6 literals
// are refused, as they were before.
function isPublicHost(hostname) {
  if (hostname.length > 253) return false;
  var ip = ipv4Pattern.exec(hostname);
  if (ip) {
    return isPublicIpv4(
      Number(ip[1]),
      Number(ip[2]),
      Number(ip[3]),
      Number(ip[4]),
    );
  }
  var labels = hostname.split(".");
  if (labels.length < 2) return false;
  for (var i = 0; i < labels.length; i++) {
    if (!hostLabelPattern.test(labels[i])) return false;
  }
  return topLabelPattern.test(labels[labels.length - 1]);
}

// Refuses private and local networks (10/8, 127/8, 169.254/16, 172.16/12,
// 192.168/16), 0.0.0.0/8, space from 224.0.0.0 up, and addresses ending in
// .0 or .255.
function isPublicIpv4(a, b, c, d) {
  if (a < 1 || a > 223 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 192 && b === 168) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  return d !== 0 && d !== 255;
}

// Builds one renderer. Every variable a render writes (tagErrs, hasError,
// tabIdx, the attribute values) lives in this closure, and XBBCODE.render
// makes a new renderer for each call. So a render that a time budget cuts
// off, or one that throws, leaves no state for the next render.
function createRenderer() {
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
  // var isFirstTableRow = true;
  var isFirstTableRow = false; // (nvm, we don't want the thead styling)
  // Global array of errors that will be concat'd to the errorQueue array at the
  // end. I use this to implement tag validation.
  var tagErrs = [];
  // A map of tagName -> Bool. openTag logic should set it to true if it
  // encounters validation error. closeTag logic should always set it back to false
  // right before it returns.
  // This allows openTag and closeTag to communicate an error state.
  var hasError = {};

  // Tags write user text into an HTML attribute only through attrValue. The
  // string passes that run after the tags (hr, greentext, smilies, mentions,
  // newlines, Autolinker) cannot tell an attribute value from text, so
  // attrValue hides each value behind a placeholder until me.render swaps it
  // back as its last step. processMarkup strips ATTR_MARK from the input, so
  // only attrValue can make a placeholder.
  var ATTR_MARK = "\u0000";
  var attrPlaceholderRegExp = /\u0000(\d+)\u0000/g;
  // The current render's attribute values, indexed by placeholder. Null
  // outside me.render, so a tag run with no render to restore its values
  // fails loudly.
  var attrValues = null;

  // text is renderer text: entry has already escaped < and > as entities,
  // and any & is the user's own, read as an entity as everywhere else in a
  // post. So this escapes the quote, plus any raw < or > from processed tag
  // content, and leaves & alone: escaping & would show "&lt;" for a typed
  // "<".
  function attrValue(text) {
    if (attrValues === null) {
      throw new Error("attrValue called outside XBBCODE.render");
    }
    if (text.indexOf(ATTR_MARK) !== -1) {
      throw new Error("attrValue got text that holds a placeholder");
    }
    attrValues.push(
      text.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    );
    return ATTR_MARK + (attrValues.length - 1) + ATTR_MARK;
  }

  function restoreAttrValues(html, values) {
    var restored = html.replace(attrPlaceholderRegExp, function (_, idx) {
      var value = values[Number(idx)];
      if (value === undefined) {
        throw new Error("bbcode attribute placeholder has no value");
      }
      return value;
    });
    if (restored.indexOf(ATTR_MARK) !== -1) {
      throw new Error("bbcode output still holds an attribute placeholder");
    }
    return restored;
  }

  function generateUuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
      /[xy]/g,
      function (c) {
        var r = (Math.random() * 16) | 0,
          v = c == "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      },
    );
  }

  // -----------------------------------------------------------------------------
  // Set up private variables
  // -----------------------------------------------------------------------------

  var me = {},
    colorNamePattern =
      /^(?:aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|green|greenyellow|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgreen|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen)$/,
    colorCodePattern = /^#?[a-fA-F0-9]{6}$/,
    emailPattern = /[^\s@]+@[^\s@]+\.[^\s@]+/,
    fontFacePattern = /^([a-z][a-z0-9_]+|"[a-z][a-z0-9_\s]+")$/i,
    tags,
    tagList,
    tagsNoParseList = [],
    bbRegExp,
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
    openTag: function (params, content) {
      // Ensure they gave us a colorCode
      if (!params) {
        tagErrs.push("You have a COLOR tag that does not specify a color");
        hasError.color = true;
        return "&#91;color&#93;";
      }

      // Ensure there's actually content
      if (content.trim().length === 0) {
        tagErrs.push("You have a COLOR tag with no contents");
        hasError.color = true;
        return "&#91;color" + params + "&#93;";
      }

      var colorCode = params.substr(1).toLowerCase();

      // Ensure colorCode is actually a color
      // TODO: Look up why library sets lastIndex to 0. Roll with it for now.
      colorNamePattern.lastIndex = 0;
      colorCodePattern.lastIndex = 0;
      if (
        !colorNamePattern.test(colorCode) &&
        !colorCodePattern.test(colorCode)
      ) {
        hasError.color = true;
        tagErrs.push(
          "You have a COLOR tag with an invalid color: " +
            "[color" +
            params +
            "]",
        );
        return "&#91;color" + params + "&#93;";
      }

      // If colorCode is a hex value, prefix it with # if it's missing
      colorCodePattern.lastIndex = 0;
      if (colorCodePattern.test(colorCode) && colorCode.substr(0, 1) !== "#") {
        colorCode = "#" + colorCode;
      }

      return '<font color="' + attrValue(colorCode) + '">';
    },
    closeTag: function (params, content) {
      var ret = hasError.color ? "&#91;/color&#93;" : "</font>";
      hasError.color = false;
      return ret;
    },
  };

  var centerSpec = {
    trimContents: true,
    openTag: function (params, content) {
      return '<div class="bb-center">';
    },
    closeTag: function (params, content) {
      return "</div>";
    },
  };

  tags = {
    //
    // Custom BBCode for the Guild
    //
    hider: {
      trimContents: true,
      openTag: function (params, content) {
        // Renderer text, already safe as element content.
        var title = params ? params.slice(1) : "Hider";
        return (
          '<div class="hider-panel">' +
          '<div class="hider-heading">' +
          '<button type="button" class="btn btn-default btn-xs hider-button" data-name="' +
          attrValue(title) +
          '">' +
          // title + ' [+]'+
          // Must use html entity code for brackets so i dont trip
          // the "there appears to be misaligned tags" err.
          title +
          " &#91;+&#93;" +
          "</button>" +
          "</div>" +
          '<div class="hider-body" style="display: none">'
        );
      },
      closeTag: function (params, content) {
        return "</div></div>";
      },
    },
    youtube: {
      displayContent: false,
      openTag: function (params, content) {
        var youtubeId = extractYoutubeId(content);
        if (!youtubeId)
          return "&#91;youtube&#93;" + content + "&#91;/youtube&#93;";
        var src = "//youtube.com/embed/" + youtubeId + "?theme=dark";
        return (
          '<iframe src="' +
          attrValue(src) +
          '" frameborder="0" width="496" height="279" allowfullscreen></iframe>'
        );
      },
      closeTag: function (params, content) {
        return "";
      },
    },
    abbr: {
      openTag: function (params, content) {
        return (
          '<abbr class="bb-abbr" title="' +
          attrValue(params ? params.slice(1) : "") +
          '">'
        );
      },
      closeTag: function (params, content) {
        return "</abbr>";
      },
    },
    code: {
      noParse: true,
      trimContents: true,
      openTag: function (params, content) {
        return "<code>";
      },
      closeTag: function (params, content) {
        return "</code>";
      },
    },
    pre: {
      noParse: true,
      trimContents: true,
      openTag: function (params, content) {
        return "<pre>";
      },
      closeTag: function (params, content) {
        return "</pre>";
      },
    },
    mark: {
      openTag: function (params, content) {
        return '<span class="bb-mark">';
      },
      closeTag: function (params, content) {
        return "</span>";
      },
    },
    indent: {
      trimContents: true,
      openTag: function (params, content) {
        return '<div class="bb-indent">';
      },
      closeTag: function (params, content) {
        return "</div>";
      },
    },
    h1: {
      trimContents: true,
      openTag: function (params, content) {
        return '<div class="bb-h1">';
      },
      closeTag: function (params, content) {
        return "</div>";
      },
    },
    h2: {
      trimContents: true,
      openTag: function (params, content) {
        return '<div class="bb-h2">';
      },
      closeTag: function (params, content) {
        return "</div>";
      },
    },
    h3: {
      trimContents: true,
      openTag: function (params, content) {
        return '<div class="bb-h3">';
      },
      closeTag: function (params, content) {
        return "</div>";
      },
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

    b: {
      openTag: function (params, content) {
        return '<span class="bb-b">';
      },
      closeTag: function (params, content) {
        return "</span>";
      },
    },
    /*
      This tag does nothing and is here mostly to be used as a classification for
      the bbcode input when evaluating parent-child tag relationships
    */
    bbcode: {
      openTag: function (params, content) {
        return "";
      },
      closeTag: function (params, content) {
        return "";
      },
    },
    center: centerSpec,
    centre: centerSpec,
    // "code": {
    //   openTag: function(params,content) {
    //     return '<pre>';
    //   },
    //   closeTag: function(params,content) {
    //     return '</pre>';
    //   },
    //   noParse: true
    // },
    color: colorSpec,
    colour: colorSpec,
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
    i: {
      openTag: function (params, content) {
        return '<span class="bb-i">';
      },
      closeTag: function (params, content) {
        return "</span>";
      },
    },
    img: {
      openTag: function (params, content) {
        return (
          '<img src="' + attrValue(parseSafeUrl(content.trim()) || "") + '" />'
        );
      },
      closeTag: function (params, content) {
        return "";
      },
      displayContent: false,
    },
    justify: {
      trimContents: true,
      openTag: function (params, content) {
        return '<div class="bb-justify">';
      },
      closeTag: function (params, content) {
        return "</div>";
      },
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
    list: {
      openTag: function (params, content) {
        return '<ul class="bb-list" style="white-space: normal;">';
      },
      closeTag: function (params, content) {
        return "</ul>";
      },
      restrictChildrenTo: ["*", "li"],
    },
    noparse: {
      openTag: function (params, content) {
        return "";
      },
      closeTag: function (params, content) {
        return "";
      },
      noParse: true,
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
    quote: {
      trimContents: true,
      openTag: function (params, content) {
        return '<blockquote class="bb-quote">';
      },
      closeTag: function (params, content) {
        var html = "";
        if (params) {
          // params starts with '=' unless user messed up.
          // e.g. '=@Mahz' or '=some guy'
          if (params.slice(1).charAt(0) === "@" && params.slice(1).length > 1) {
            // This is a @uname mention
            var uname = params.slice(2);
            html += "<footer>&#91;@" + uname + "&#93;</footer>";
          } else {
            var source = params.slice(1);
            html += "<footer>" + source + "</footer>";
          }
        }
        html = html + "</blockquote>";
        return html;
      },
    },
    right: {
      trimContents: true,
      openTag: function (params, content) {
        return '<div class="bb-right">';
      },
      closeTag: function (params, content) {
        return "</div>";
      },
    },
    s: {
      openTag: function (params, content) {
        return '<span class="bb-s">';
      },
      closeTag: function (params, content) {
        return "</span>";
      },
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
    sub: {
      openTag: function (params, content) {
        return "<sub>";
      },
      closeTag: function (params, content) {
        return "</sub>";
      },
    },
    sup: {
      openTag: function (params, content) {
        return "<sup>";
      },
      closeTag: function (params, content) {
        return "</sup>";
      },
    },
    table: {
      openTag: function (params, content) {
        if (params && params.slice(1) === "bordered")
          return '<div class="table-responsive"><table class="bb-table bb-table-bordered">';
        return '<div class="table-responsive"><table class="bb-table">';
      },
      closeTag: function (params, content) {
        // isFirstTableRow = true;
        return "</table></div>";
      },
      // restrictChildrenTo: ["tbody","thead", "tfoot", "tr"]
      restrictChildrenTo: ["row"],
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
    cell: {
      openTag: function (params, content) {
        if (isFirstTableRow) return '<th class="bb-th">';

        var classNames = [],
          status;
        // Determine the status if one is given.
        switch (params && params.slice(1)) {
          case "active":
            status = "active";
            break;
          case "success":
            status = "success";
            break;
          case "warning":
            status = "warning";
            break;
          case "danger":
            status = "danger";
            break;
          case "info":
            status = "info";
            break;
          default:
            break;
        }
        classNames.push("bb-td");
        if (status) classNames = classNames.concat([status, "bb-" + status]);
        return '<td class="' + classNames.join(" ") + '">';
      },
      closeTag: function (params, content) {
        if (isFirstTableRow) return "</th>";
        return "</td>";
      },
      restrictParentsTo: ["row"],
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
    row: {
      openTag: function (params, content) {
        if (isFirstTableRow) {
          return '<thead class="bb-thead"><tr class="bb-tr">';
        }

        var classNames = [],
          status;
        // Determine the status if one is given.
        switch (params && params.slice(1)) {
          case "active":
            status = "active";
            break;
          case "success":
            status = "success";
            break;
          case "warning":
            status = "warning";
            break;
          case "danger":
            status = "danger";
            break;
          case "info":
            status = "info";
            break;
          default:
            break;
        }
        classNames.push("bb-tr");
        if (status) classNames = classNames.concat([status, "bb-" + status]);
        return '<tr class="' + classNames.join(" ") + '">';
      },
      closeTag: function (params, content) {
        var html;
        if (isFirstTableRow) html = "</tr></thead>";
        else html = "</tr>";
        isFirstTableRow = false;
        return html;
      },
      restrictChildrenTo: ["cell"],
      restrictParentsTo: ["table"],
    },
    u: {
      openTag: function (params, content) {
        return '<span class="bb-u">';
      },
      closeTag: function (params, content) {
        return "</span>";
      },
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
    url: {
      trimContents: true,
      openTag: function (params, content) {
        var myUrl;

        if (!params) {
          myUrl = content.trim().replace(/<.*?>/g, "");
        } else {
          myUrl = params.trim().substr(1).trim();
        }

        if (myUrl.indexOf("http") !== 0 && myUrl.indexOf("ftp://") !== 0) {
          // they don't have a valid protocol at the start, so add one [#63]
          myUrl = "http://" + myUrl;
        }

        var href = parseSafeUrl(myUrl);
        if (!href) {
          hasError.url = true;
          tagErrs.push("One of your [url] tags has an invalid url");
          if (params) return "&#91;url=" + myUrl + "&#93;";
          else return "&#91;url&#93;";
        }

        // dumb way to see if user is linking internally or externally
        // keep synced with Autolinker#replaceFn definedin this file
        if (/roleplayerguild.com/i.test(href)) {
          // internal link
          return '<a href="' + attrValue(href) + '">';
        } else {
          // external link
          return (
            '<a target="_blank" rel="nofollow noopener" href="' +
            attrValue(href) +
            '">'
          );
        }
      },
      closeTag: function (params, content) {
        var ret = hasError.url ? "&#91;/url&#93;" : "</a>";
        hasError.url = false;
        return ret;
      },
    },
    /*
      The [*] tag is special since the user does not define a closing [/*] tag when writing their bbcode.
      Instead this module parses the code and adds the closing [/*] tag in for them. None of the tags you
      add will act like this and this tag is an exception to the others.
    */
    "*": {
      trimContents: true,
      openTag: function (params, content) {
        return "<li>";
      },
      closeTag: function (params, content) {
        return "</li>";
      },
      restrictParentsTo: ["list", "ul", "ol"],
    },
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
          if (tags[prop].noParse) {
            tagsNoParseList.push(prop);
          }
        }

        tags[prop].validChildLookup = {};
        tags[prop].validParentLookup = {};
        tags[prop].restrictParentsTo = tags[prop].restrictParentsTo || [];
        tags[prop].restrictChildrenTo = tags[prop].restrictChildrenTo || [];

        len = tags[prop].restrictChildrenTo.length;
        for (ii = 0; ii < len; ii++) {
          tags[prop].validChildLookup[tags[prop].restrictChildrenTo[ii]] = true;
        }
        len = tags[prop].restrictParentsTo.length;
        for (ii = 0; ii < len; ii++) {
          tags[prop].validParentLookup[tags[prop].restrictParentsTo[ii]] = true;
        }
      }
    }

    bbRegExp = new RegExp(
      "<bbcl=([0-9]+) (" +
        tagList.join("|") +
        ")([ =][^>]*?)?>((?:.|[\\r\\n])*?)<bbcl=\\1 /\\2>",
      "gi",
    );

    // create the regex for escaping ['s that aren't apart of tags
    (function () {
      var closeTagList = [];
      for (var ii = 0; ii < tagList.length; ii++) {
        if (tagList[ii] !== "\\*") {
          // the * tag doesn't have an offical closing tag
          closeTagList.push("/" + tagList[ii]);
        }
      }

      openTags = new RegExp(
        "(\\[)((?:" + tagList.join("|") + ")(?:[ =][^\\]]*?)?)(\\])",
        "gi",
      );
      closeTags = new RegExp(
        "(\\[)(" + closeTagList.join("|") + ")(\\])",
        "gi",
      );
    })();
  }
  initTags();

  // -----------------------------------------------------------------------------
  // private functions
  // -----------------------------------------------------------------------------

  // Checks each paired tag against its parent's restrictChildrenTo and its
  // own restrictParentsTo. root is the tree from addBbcodeLevels. An explicit
  // stack walks it, so no nesting depth can overflow the call stack. Errors
  // come in the order the old recursive check gave them: a tag's children
  // first, then each child's subtree in turn.
  function checkParentChildRestrictions(root) {
    var errQueue = [];
    var pending = [root];
    while (pending.length > 0) {
      var parent = pending.pop();
      var pInfo = tags[parent.name];
      for (var ii = 0; ii < parent.children.length; ii++) {
        var childTag = parent.children[ii].name;
        var cInfo = tags[childTag];
        if (
          pInfo.restrictChildrenTo.length > 0 &&
          !pInfo.validChildLookup[childTag]
        ) {
          errQueue.push(
            'The tag "' +
              childTag +
              '" is not allowed as a child of the tag "' +
              parent.name +
              '".',
          );
        }
        if (
          cInfo.restrictParentsTo.length > 0 &&
          !cInfo.validParentLookup[parent.name]
        ) {
          errQueue.push(
            'The tag "' +
              parent.name +
              '" is not allowed as a parent of the tag "' +
              childTag +
              '".',
          );
        }
      }
      for (var jj = parent.children.length - 1; jj >= 0; jj--) {
        pending.push(parent.children[jj]);
      }
    }
    return errQueue;
  }

  /*
    This function removes the metadata added by the addBbcodeLevels function
  */
  function unprocess(tagContent) {
    return tagContent
      .replace(/<bbcl=[0-9]+ \/\*>/gi, "")
      .replace(/<bbcl=[0-9]+ /gi, "&#91;")
      .replace(/>/gi, "&#93;");
  }

  var replaceFunct = function (
    matchStr,
    bbcodeLevel,
    tagName,
    tagParams,
    tagContents,
  ) {
    tagName = tagName.toLowerCase();

    var processedContent = tags[tagName].noParse
        ? unprocess(tagContents)
        : tagContents.replace(bbRegExp, replaceFunct),
      openTag = tags[tagName].openTag(tagParams, processedContent),
      closeTag = tags[tagName].closeTag(tagParams, processedContent);

    if (tags[tagName].displayContent === false) {
      processedContent = "";
    }

    if (tags[tagName].trimContents) {
      processedContent = processedContent.trim();
    }

    return (
      openTag +
      processedContent.replace(/^\n+/, "").replace(/\n+$/, "") +
      closeTag
    );
  };

  function parse(config) {
    var output = config.text;
    output = output.replace(bbRegExp, replaceFunct);
    return output;
  }

  /*
    The star tag [*] is special in that it does not use a closing tag. Since
    this parser requires every tag to have a closing tag, this pass adds the
    [/*] tags. Every [ left in the text by now starts a known tag.

    It works in one pass with a stack of open lists, and it gives the same
    text as the loop it replaced, which rescanned the text once per list
    item and once per level of list nesting:
    - Lists pair like brackets. A [list] or [/list] that never pairs has its
      [ turned into >, as before.
    - When a list closes, each bare [*] directly in it gets a [/*] when the
      next [* tag still waiting in the list is a bare [*], or when no [* tag
      is waiting. The [/*] goes before that tag, or before the [/list]. A
      [* x] or [*=x] never gets one, and neither does a bare [*] followed by
      one.
    - The [* tags still waiting in a nested list wait in the outer list too,
      so the first of them can be the "next tag" of a [*] in the outer list.
  */
  function fixStarTag(text) {
    var tokenRe = /\[(?:list(?:[ =][^\]]*)?\]|\/list\]|\*[ =\]])/gi;
    // The open lists. Each frame holds the [* tags waiting in it, in order:
    // its own, plus the first waiting tag of each nested list.
    var stack = [];
    // Indexes in text where a [/*] goes.
    var inserts = [];
    // Indexes of the [ of list tags that never pair.
    var unpaired = [];
    // Indexes of [/list] tags to write in lower case, as the old pass did
    // when it closed a list's last item.
    var lowered = [];
    var match;
    while ((match = tokenRe.exec(text))) {
      var token = match[0];
      var pos = match.index;
      if (token.charAt(1) === "*") {
        if (stack.length > 0) {
          stack[stack.length - 1].waiting.push({
            pos: pos,
            bare: token === "[*]",
            own: true,
          });
        }
      } else if (token.charAt(1) !== "/") {
        stack.push({ open: pos, waiting: [] });
      } else if (stack.length === 0) {
        unpaired.push(pos);
      } else {
        var frame = stack.pop();
        var first = null;
        for (var ii = 0; ii < frame.waiting.length; ii++) {
          var item = frame.waiting[ii];
          var next = frame.waiting[ii + 1];
          if (item.own && item.bare && (!next || next.bare)) {
            inserts.push(next ? next.pos : pos);
            if (!next) lowered.push(pos);
          } else if (first === null) {
            first = item;
          }
        }
        if (first !== null && stack.length > 0) {
          stack[stack.length - 1].waiting.push({
            pos: first.pos,
            bare: first.bare,
            own: false,
          });
        }
      }
    }
    for (var jj = 0; jj < stack.length; jj++) {
      unpaired.push(stack[jj].open);
    }
    if (inserts.length === 0 && unpaired.length === 0) return text;

    var edits = [];
    for (jj = 0; jj < inserts.length; jj++) {
      edits.push({ pos: inserts[jj], kind: 0 });
    }
    for (jj = 0; jj < lowered.length; jj++) {
      edits.push({ pos: lowered[jj], kind: 1 });
    }
    for (jj = 0; jj < unpaired.length; jj++) {
      edits.push({ pos: unpaired[jj], kind: 2 });
    }
    // At one index, a [/*] goes before the tag it precedes.
    edits.sort(function (a, b) {
      return a.pos - b.pos || a.kind - b.kind;
    });
    var out = "";
    var last = 0;
    for (jj = 0; jj < edits.length; jj++) {
      var edit = edits[jj];
      out += text.slice(last, edit.pos);
      last = edit.pos;
      if (edit.kind === 0) {
        out += "[/*]";
      } else if (edit.kind === 1) {
        out += "[/list]";
        last += "[/list]".length;
      } else {
        out += ">";
        last += 1;
      }
    }
    return out + text.slice(last);
  }

  /*
    Pairs each open tag with its close, and writes the pair's nesting depth
    into both as <bbcl=N name params> and <bbcl=N /name>, for parse. Depth 0
    is the outermost. Every [ left in the text by now starts a known tag.

    It works in one pass with a stack, and it pairs tags as the loop it
    replaced did. That loop paired the innermost tags once per level of
    nesting:
    - An open pairs with the first tag after it, once the pairs between them
      are taken out, if that tag closes the same name.
    - Any other tag there never pairs, and no open before it can pair with a
      close after it.
    - Inside a pair, a ] that ends no tag (from a list tag fixStarTag left
      unpaired) becomes >.

    Returns { text, root, tooDeep }. root is the tree of pairs, for
    checkParentChildRestrictions. When pairs nest more than MAX_TAG_DEPTH
    deep, tooDeep is true and nothing is converted. That keeps the cost of
    later passes, and the depth of parse's recursion, bounded by
    MAX_TAG_DEPTH times the length of the text.
  */
  function addBbcodeLevels(text) {
    var tokenRe = new RegExp(
      "\\[(?:\\/(" +
        tagList.join("|") +
        ")\\]|(" +
        tagList.join("|") +
        ")(?:[ =][^\\]]*?)?\\])?",
      "gi",
    );
    var tokens = [];
    // Indexes into tokens of the opens that may still pair.
    var stack = [];
    var match;
    while ((match = tokenRe.exec(text))) {
      var closeName = match[1];
      var openName = match[2];
      if (openName !== undefined) {
        stack.push(tokens.length);
        tokens.push({
          start: match.index,
          end: tokenRe.lastIndex,
          name: openName.toLowerCase(),
          isClose: false,
          paired: false,
        });
        continue;
      }
      var top = stack.length > 0 ? tokens[stack[stack.length - 1]] : null;
      if (
        closeName !== undefined &&
        top !== null &&
        top.name === closeName.toLowerCase()
      ) {
        stack.pop();
        top.paired = true;
        tokens.push({
          start: match.index,
          end: tokenRe.lastIndex,
          name: top.name,
          isClose: true,
          paired: true,
        });
      } else {
        // A close that pairs with nothing, or a [ that starts no known tag.
        stack.length = 0;
      }
    }

    var root = { name: "bbcode", children: [] };
    var parents = [root];
    var maxDepth = 0;
    var ii, token;
    for (ii = 0; ii < tokens.length; ii++) {
      token = tokens[ii];
      if (!token.paired) continue;
      if (token.isClose) {
        parents.pop();
        token.depth = parents.length - 1;
      } else {
        token.depth = parents.length - 1;
        var node = { name: token.name, children: [] };
        parents[parents.length - 1].children.push(node);
        parents.push(node);
        maxDepth = Math.max(maxDepth, parents.length - 1);
      }
    }
    if (maxDepth > MAX_TAG_DEPTH) {
      return {
        text: text,
        root: { name: "bbcode", children: [] },
        tooDeep: true,
      };
    }

    var out = "";
    var last = 0;
    var inside = 0;
    for (ii = 0; ii < tokens.length; ii++) {
      token = tokens[ii];
      if (!token.paired) continue;
      var between = text.slice(last, token.start);
      out += inside > 0 ? between.replace(/\]/g, ">") : between;
      out +=
        "<bbcl=" +
        token.depth +
        " " +
        text.slice(token.start + 1, token.end - 1) +
        ">";
      inside += token.isClose ? -1 : 1;
      last = token.end;
    }
    return { text: out + text.slice(last), root: root, tooDeep: false };
  }

  // -----------------------------------------------------------------------------
  // public functions
  // -----------------------------------------------------------------------------

  // API, Expose all available tags
  me.tags = function () {
    return tags;
  };

  // Escapes the brackets inside each [code], [pre] and [noparse] pair, so
  // their content does not parse. It gives the same text as the one regex
  // replace it took over from. That regex searched from each unclosed open
  // to the end of the text, so a run of unclosed opens took quadratic time.
  // Here, once a search for a name's close finds none, no later open of that
  // name searches again.
  function escapeNoParseContents(text) {
    var openRe = new RegExp(
      "\\[(" + tagsNoParseList.join("|") + ")([ =][^\\]]*?)?\\]",
      "gi",
    );
    var closeRes = {};
    var out = "";
    var last = 0;
    var match;
    while ((match = openRe.exec(text))) {
      var name = match[1].toLowerCase();
      if (closeRes[name] === null) continue;
      var closeRe =
        closeRes[name] ||
        (closeRes[name] = new RegExp("\\[/" + name + "\\]", "gi"));
      closeRe.lastIndex = openRe.lastIndex;
      var close = closeRe.exec(text);
      if (!close) {
        closeRes[name] = null;
        continue;
      }
      var contents = text
        .slice(openRe.lastIndex, close.index)
        .replace(/\[/g, "&#91;")
        .replace(/\]/g, "&#93;");
      out +=
        text.slice(last, match.index) +
        "[" +
        match[1] +
        (match[2] || "") +
        "]" +
        contents +
        "[/" +
        match[1] +
        "]";
      last = openRe.lastIndex = closeRe.lastIndex;
    }
    return out + text.slice(last);
  }

  // Private: only me.render may run it, since its output holds attribute
  // placeholders that me.render swaps back.
  function processMarkup(config) {
    var ret = { html: "", error: false, tooDeep: false },
      errQueue = [];

    // Only attrValue may make a placeholder.
    config.text = config.text.split(ATTR_MARK).join("");
    config.text = config.text.replace(/</g, "&lt;"); // escape HTML tag brackets
    config.text = config.text.replace(/>/g, "&gt;"); // escape HTML tag brackets

    // openTags searches a tag's params for the ] that ends it. After the
    // last ] in the text that search can never succeed, and running it from
    // each [ there took quadratic time. No tag can open there, so only the
    // text up to the last ] is searched.
    var lastBracket = config.text.lastIndexOf("]");
    config.text =
      config.text
        .slice(0, lastBracket + 1)
        .replace(openTags, function (matchStr, openB, contents, closeB) {
          return "<" + contents + ">";
        }) + config.text.slice(lastBracket + 1);
    config.text = config.text.replace(
      closeTags,
      function (matchStr, openB, contents, closeB) {
        return "<" + contents + ">";
      },
    );

    config.text = config.text.replace(/\[/g, "&#91;"); // escape ['s that aren't apart of tags
    config.text = config.text.replace(/\]/g, "&#93;"); // escape ['s that aren't apart of tags
    config.text = config.text.replace(/</g, "["); // escape ['s that aren't apart of tags
    config.text = config.text.replace(/>/g, "]"); // escape ['s that aren't apart of tags

    // process tags that don't have their content parsed
    while (config.text !== (config.text = escapeNoParseContents(config.text)));

    config.text = fixStarTag(config.text); // add in closing tags for the [*] tag
    var levels = addBbcodeLevels(config.text); // add in level metadata
    config.text = levels.text;
    errQueue = checkParentChildRestrictions(levels.root);
    if (levels.tooDeep) {
      ret.tooDeep = true;
      errQueue.push(tooDeepMessage);
    }

    ret.html = parse(config);

    // Replace [hr] with <hr>
    ret.html = replaceHr(ret.html);

    // Wrap >greentext with styling
    ret.html = replaceGreenText(ret.html);

    if (ret.html.indexOf("[") !== -1 || ret.html.indexOf("]") !== -1) {
      errQueue.push("Some tags appear to be misaligned.");
    }

    if (config.removeMisalignedTags) {
      ret.html = ret.html.replace(/\[.*?\]/g, "");
    }
    if (config.addInLineBreaks) {
      ret.html = '<div style="white-space:pre-wrap;">' + ret.html + "</div>";
    }

    // ret.html = ret.html.replace("&#91;", "["); // put ['s back in
    // ret.html = ret.html.replace("&#93;", "]"); // put ['s back in
    // Needed to patch above 2 lines of library code to replace all instances
    ret.html = ret.html.replace(/&#91;/g, "[").replace(/&#93;/g, "]");

    // Replace smilie codes with <img>s
    ret.html = replaceSmilies(ret.html);

    // Replace [@Mentions] with a link
    ret.html = replaceMentions(ret.html);

    ret.html = ret.html.replace(/\t/g, "&#9;");
    ret.html = ret.html.replace(/\r/g, "");
    ret.html = ret.html.replace(/\n{2,}/g, "\n\n");
    ret.html = ret.html.replace(/\n/g, "<br>");

    // concat tagErrs into errQueue at the last second
    // and then reset it for next run.
    errQueue = errQueue.concat(tagErrs);
    tagErrs = [];

    ret.error = errQueue.length !== 0;
    ret.errorQueue = errQueue;

    return ret;
  }

  // Tags and string passes, then Autolinker, then attribute values swapped
  // back last so that no pass can reach them.
  me.render = function (markup) {
    attrValues = [];
    try {
      var ret = processMarkup({ text: markup, addInLineBreaks: true });
      ret.html = restoreAttrValues(
        Autolinker.link(ret.html, autolinkerOpts),
        attrValues,
      );
      return ret;
    } finally {
      attrValues = null;
    }
  };

  return me;
}

var XBBCODE = {
  // API. The one render path for the server export, the editor preview and
  // the cheatsheet. Returns { html, error, errorQueue, tooDeep }.
  render: function (markup) {
    return createRenderer().render(markup);
  },
  tagNames: function () {
    return Object.keys(createRenderer().tags());
  },
};

var autolinkerOpts = {
  stripPrefix: true,
  truncate: 40,
  email: false,
  phone: false,
  twitter: false,
  hashtag: false,
  newWindow: false,
  // keep synced with [url] logic
  replaceFn: function (match) {
    //var tag = autolinker.getTagBuilder().build(match);
    var tag = match.buildTag();
    // dumb way to see if user is linking internally or externally
    if (!/roleplayerguild.com/i.test(match.getAnchorHref())) {
      tag.setAttr("rel", "nofollow noopener").setAttr("target", "_blank");
    }
    return tag;
  },
};

// The server refuses markup the renderer marks tooDeep, with a message the
// member sees.
function renderOrRefuse(markup) {
  var ret = XBBCODE.render(markup);
  if (ret.tooDeep) throw new MarkupRejected(tooDeepMessage);
  return ret.html;
}

// Allow public/js/chat.js to access it
if (isBrowser) {
  window.autolinkerOpts = autolinkerOpts;
}

if (typeof window === "undefined") {
  // We're on the server, so export module. Only server/markup.ts calls it,
  // inside its length cap and time budget. Its html is what gets stored, so
  // it always passes the sanitizer in server/user_html.ts.
  module.exports = function (markup) {
    return userHtml.sanitizeUserHtml(renderOrRefuse(markup));
  };
  // The renderer's html before the sanitizer, for code that checks or wraps
  // the two steps apart. Never store it.
  module.exports.renderUnsanitized = renderOrRefuse;
  module.exports.tagNames = XBBCODE.tagNames();
  module.exports.MAX_TAG_DEPTH = MAX_TAG_DEPTH;
} else {
  // We're on the client so export to window
  window.bbcode = function (markup) {
    return XBBCODE.render(markup).html;
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
