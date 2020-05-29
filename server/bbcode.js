/*
       TODO: Patch xbbcode.js so the library itself is compat with node
*/

// Boolean representing whether or not this file is being executed on the
// server or not. If false, we're on the browser.
var isServer = typeof window === 'undefined'
var isBrowser = typeof window !== 'undefined'

var util, cache
if (isServer) {
    // Node
    util = require('util')
    // 3rd party
    var Autolinker = require('autolinker')
    // 1st party
    cache = require('./cache')
}

function escapeHtml(unsafe) {
    return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
}

// String -> Maybe String
function extractYoutubeId(url) {
    var re = /^.*(?:youtu.be\/|v\/|e\/|u\/\w+\/|embed\/|v=)([A-Za-z0-9_\-]{11}).*/
    var match = url.match(re)
    return match && match[1]
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
    var re = /\[(quote)=?@?([a-z0-9_\- ]+)?\]|\[(\/quote)\]/gi
    // A quoteStack item is { idx: Int, uname: String | undefined }
    var quoteStack = []

    // match[1] is 'quote' (opening quote tag)
    // match[2] is 'uname' of [quote=uname]. Only maybe present when match[1] exists
    // match[3] is '/quote' (closing quote)
    while (true) {
        var match = re.exec(markup)
        if (!match) {
            break
        } else {
            if (match[1]) {
                // Open quote tag
                var uname = match[2] // String | undefined
                quoteStack.push({ idx: match.index, uname: uname })
            } else if (match[3]) {
                // Close quote tag
                // - If there's only 1 quote on the quoteStack, we know this is a top-level
                //   quote that we want to replace with '<Snip>'
                // - If there are more than 1 quote on the stack, then just pop() and loop.
                //   Means we're in a nested quote.
                // - If quoteStack is empty just loop
                if (quoteStack.length > 1) {
                    quoteStack.pop()
                } else if (quoteStack.length === 1) {
                    //debug(match.input);
                    var startIdx = quoteStack[0].idx
                    var endIdx = match.index + '[/quote]'.length
                    var quote = quoteStack.pop()
                    var newMarkup =
                        match.input.slice(0, startIdx) +
                        (quote.uname
                            ? '<Snipped quote by ' + quote.uname + '>'
                            : '<Snipped quote>') +
                        match.input.slice(endIdx)

                    markup = newMarkup
                    re.lastIndex = re.lastIndex - (endIdx - startIdx)
                }
            }
        }
    }

    return markup
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
    'zzz',
]
var smilieRegExp = new RegExp(':(' + smilies.join('|') + ')', 'ig')

function replaceSmilies(text) {
    return text.replace(smilieRegExp, '<img src="/smilies/$1.gif">')
}

var greenTextRegExp = /^((?:<[^>]+>)*)(&gt;\S.*)$/gm
function replaceGreenText(text) {
    return text.replace(
        greenTextRegExp,
        '$1<span class="bb-greentext">$2</span>'
    )
}
/*
function replaceHr(text) {
    return text.replace(/&#91;hr&#93;/g, '<hr class="bb-hr">')
}
*/
// Replace unames

function replaceMentions(text) {
    function slugifyUname(uname) {
        return uname
            .trim()
            .toLowerCase()
            .replace(/ /g, '-')
    }
    return text.replace(/\[@([a-z0-9_\- ]+)\]/gi, function(_, p1) {
        var uname = p1.trim()
        var path = '/users/' + slugifyUname(uname)
        if (isBrowser) {
            // If we're on the browser, just render anchor every time
            // TODO: Only render mentions in browser is uname exists in DB
            return (
                '<a class="bb-mention" href="' + path + '">@' + uname + '</a>'
            )
        } else {
            // If we're on the server, then only render anchor if uname exists in DB.
            var trie = cache.get('uname-regex-trie')
            if (trie.contains(uname.toLowerCase())) {
                return (
                    '<a class="bb-mention" href="' +
                    path +
                    '">@' +
                    uname +
                    '</a>'
                )
            } else {
                return '[@' + uname + ']'
            }
        }
    })
}

var XBBCODE = (function() {
    ////
    //// Here are some nasty global variables that let me add in some stateful
    //// hacks until I have time to find better ways to do these things.
    ////
    //
    // Global tabIdx cursor so that [tab] context knows when it's first
    // in the array of [tabs] children.
    //var tabIdx = 0
    // Only true for the first [row] parsed within a [table]
    // This lets me wrap the first [row] with a <thead>
    var isFirstTableRow = true


/*
    function generateUuid() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(
            c
        ) {
            var r = (Math.random() * 16) | 0,
                v = c == 'x' ? r : (r & 0x3) | 0x8
            return v.toString(16)
        })
    }
*/
    // -----------------------------------------------------------------------------
    // Set up private variables
    // -----------------------------------------------------------------------------

    var me = {},
        // This library's default:
        //urlPattern = /^[-a-z0-9:;@#%&()~_?\+=\/\\\.]+$/i,

        // https://mathiasbynens.be/demo/url-regex
        // Source from https://gist.github.com/dperini/729294
        urlPattern = new RegExp(
            '^' +
                // protocol identifier
                '(?:(?:https?|ftp)://)' +
                // user:pass authentication
                '(?:\\S+(?::\\S*)?@)?' +
                '(?:' +
                // IP address exclusion
                // private & local networks
                '(?!(?:10|127)(?:\\.\\d{1,3}){3})' +
                '(?!(?:169\\.254|192\\.168)(?:\\.\\d{1,3}){2})' +
                '(?!172\\.(?:1[6-9]|2\\d|3[0-1])(?:\\.\\d{1,3}){2})' +
                // IP address dotted notation octets
                // excludes loopback network 0.0.0.0
                // excludes reserved space >= 224.0.0.0
                // excludes network & broacast addresses
                // (first & last IP address of each class)
                '(?:[1-9]\\d?|1\\d\\d|2[01]\\d|22[0-3])' +
                '(?:\\.(?:1?\\d{1,2}|2[0-4]\\d|25[0-5])){2}' +
                '(?:\\.(?:[1-9]\\d?|1\\d\\d|2[0-4]\\d|25[0-4]))' +
                '|' +
                // host name
                '(?:(?:[a-z\\u00a1-\\uffff0-9]-*)*[a-z\\u00a1-\\uffff0-9]+)' +
                // domain name
                '(?:\\.(?:[a-z\\u00a1-\\uffff0-9]-*)*[a-z\\u00a1-\\uffff0-9]+)*' +
                // TLD identifier
                '(?:\\.(?:[a-z\\u00a1-\\uffff]{2,}))' +
                ')' +
                // port number
                '(?::\\d{2,5})?' +
                // resource path
                '(?:/\\S*)?' +
                '$',
            'i'
        ),
        colorNamePattern = /^(?:aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|green|greenyellow|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgreen|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen)$/,
        colorCodePattern = /^#?[a-fA-F0-9]{6}$/,
        emailPattern = /[^\s@]+@[^\s@]+\.[^\s@]+/,
        fontFacePattern = /^([a-z][a-z0-9_\s]+)$/i,
        tags,
        tagList,
        tagsNoParseList = [],
        bbRegExp,
        pbbRegExp,
        pbbRegExp2,
        openTags,
        closeTags

    /* -----------------------------------------------------------------------------
   * tags
   * This object contains a list of tags that your code will be able to understand.
   * Each tag object has the following properties:
   *
   *   openTag - A function that takes in the tag's parameters (if any), its
   *             contents, the current tag stack (with structure [tag, contents],
   *             and the error queue and returns what its HTML open tag should be.
   *             Example: [color=red]test[/color] would take in "red" as a
   *             parameter input, and "test" as a content input.
   *             It should be noted that any BBCode inside of "content" will have
   *             been processed by the time it enter the openTag function.
   *
   *   closeTag - A function that takes in the tag's parameters (if any) and its
	*              contents, the current tag stack (with structure {tag, tagData},
   *              and the error queue and returns what its HTML close tag should be.
   *
   *
   * LIMITIONS on adding NEW TAGS:
   *  - Tag names cannot start with an @.
   *  - If a tag's content is not supposed to be parsed, add it to the stopTag dictionary
   *  - If a tag has no closing counterpart (e.g. [hr]), add it to the singleTag dictionary
   *  - If a tag has a standard open and close tag structure, add it to the tags dictionary
   *  - Allowing tags to inject additional raw BBCode is unsupported. Attempt at your own risk
   * --------------------------------------------------------------------------- */

    // Extracting BBCode implementations makes it simpler to create aliases
    // like color & colour -> colorSpec
    var colorSpec = {
		colorErrorStack: [],
		//Variable local to the object that determines whether the colors are valid
		//It's a stack so it can keep track of the corresponding closing tags in the case of an error
        openTag: function(params, content, tagStack, errorQueue) {
            // Ensure they gave us a colorCode
            if (!params) {
                errorQueue.push(
                    'You have a COLOR tag that does not specify a color'
                )
                this.colorErrorStack.push(true)
                return '&#91;color&#93;'
            }

            var colorCode = params.toLowerCase()

            // Ensure colorCode is actually a color
            // TODO: Look up why library sets lastIndex to 0. Roll with it for now.
            colorNamePattern.lastIndex = 0
            colorCodePattern.lastIndex = 0
            if (
                !colorNamePattern.test(colorCode) &&
                !colorCodePattern.test(colorCode)
            ) {
                errorQueue.push(
                    'You have a COLOR tag with an invalid color: ' +
                        '[color=' +
                        params +
                        ']'
                )
				this.colorErrorStack.push(true)
                return '&#91;color=' + params + '&#93;'
            }

            // If colorCode is a hex value, prefix it with # if it's missing
            colorCodePattern.lastIndex = 0
            if (
                colorCodePattern.test(colorCode) &&
                colorCode.substr(0, 1) !== '#'
            ) {
                colorCode = '#' + colorCode
            }
			this.colorErrorStack.push(false)
			//False indicating that this color tag is not invalid
            return '<font color="' + colorCode + '">'
        },
        closeTag: function(params, content, tagStack, errorQueue) {
            return this.colorErrorStack.pop() ? '&#91;/color&#93;' : '</font>'
			//Pop is always a safe operation because if there's an imbalance in tags, it'll be handled in parseBBCode
        },
    }

    var centerSpec = {
        trimContents: true,
        openTag: function(params, content) {
            return '<div class="bb-center">'
        },
        closeTag: function(params, content) {
            return '</div>'
        },
    }

	var tagInStack = function(tagStack, tag){
		for(let i = 0; i < tagStack.length; i++)
		{
			if(tagStack[i].tag == tag){
				return true
			}
		}
		return false
	}
	var makeUnique = function(a) {
		var seen = {};
		return a.filter(function(item) {
			return seen.hasOwnProperty(item) ? false : (seen[item] = true);
		});
	}
	singleTags = {
		hr: {
            openTag: function(params, content) {
                return '<hr class="bb-hr">'
            }
		},
		br: {
            openTag: function(params, content) {
                return '<br>'
            }
		}
	}

	stopTags = {
		youtube: {
            openTag: function(params, content, tagStack, errorQueue) {
                var youtubeId = extractYoutubeId(content)
                if (!youtubeId){
					errorQueue.push('The video URL appears to be invalid')
                    return '&#91;youtube&#93;' + content +' &#91;/youtube]'
					//TO DO: Fix AutoLinker incompatibilities. For now, there's a space before [/youtube] to fix the broken hotlinking
				}
                var src = 'https://youtube.com/embed/' + youtubeId + '?theme=dark'
                return (
                    '<iframe src="' +
                    src +
                    '" frameborder="0" width="496" height="279" allowfullscreen></iframe>'
                )
            },
            closeTag: function(params, content) {
                return ''
            },
        },
        code: {
            trimContents: true,
            openTag: function(params, content) {
                return '<code>' + content
            },
            closeTag: function(params, content) {
                return '</code>'
            },
        },
        pre: {
            trimContents: true,
            openTag: function(params, content) {
                return '<pre>' + content
            },
            closeTag: function(params, content) {
                return '</pre>'
            },
        },
		img: {
            openTag: function(params, content) {
                var myUrl = content.trim()

                urlPattern.lastIndex = 0
                if (!urlPattern.test(myUrl)) {
                    myUrl = ''
                }

                return '<img src="' + escapeHtml(myUrl) + '" />'
            },
            closeTag: function(params, content) {
                return ''
            },
        },
        noparse: {
            openTag: function(params, content) {
                return content
            },
            closeTag: function(params, content) {
                return ''
            },
        },
		legend: {
            openTag: function(params, content) {
                return '<a target="_blank" rel="nofollow noopener" href="https://YouTube.com/LegendBegins">' + content + '</a>'
				//Contributor Easter Egg. Feel free to remove
            },
			closeTag: function(params, content) {
                return ''
            }
		}
	}
    tags = {
        //
        // Custom BBCode for the Guild
        //
        hider: {
            trimContents: true,
            openTag: function(params, content) {
                var title = params ? escapeHtml(params) : 'Hider'
                return (
                    '<div class="hider-panel">' +
                    '<div class="hider-heading">' +
                    '<button type="button" class="btn btn-default btn-xs hider-button" data-name="' +
                    title +
                    '">' +
                    // title + ' [+]'+
                    //Using html entity code for bracket
                    title +
                    ' &#91;+&#93;' +
                    '</button>' +
                    '</div>' +
                    '<div class="hider-body" style="display: none">'
                )
            },
            closeTag: function(params, content) {
                return '</div></div>'
            },
        },
        abbr: {
            openTag: function(params, content) {
                return (
                    '<abbr class="bb-abbr" title="' +
                    (params) +
                    '">'
                )
            },
            closeTag: function(params, content) {
                return '</abbr>'
            },
        },
        mark: {
            openTag: function(params, content) {
                return '<span class="bb-mark">'
            },
            closeTag: function(params, content) {
                return '</span>'
            },
        },
        indent: {
            trimContents: true,
            openTag: function(params, content) {
                return '<div class="bb-indent">'
            },
            closeTag: function(params, content) {
                return '</div>'
            },
        },
        h1: {
            trimContents: true,
            openTag: function(params, content) {
                return '<div class="bb-h1">'
            },
            closeTag: function(params, content) {
                return '</div>'
            },
        },
        h2: {
            trimContents: true,
            openTag: function(params, content) {
                return '<div class="bb-h2">'
            },
            closeTag: function(params, content) {
                return '</div>'
            },
        },
        h3: {
            trimContents: true,
            openTag: function(params, content) {
                return '<div class="bb-h3">'
            },
            closeTag: function(params, content) {
                return '</div>'
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
        //     var title = params ? params : 'Tab';
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
            openTag: function(params, content) {
                return '<span class="bb-b">'
            },
            closeTag: function(params, content) {
                return '</span>'
            },
        },
        /*
      This tag does nothing and is here mostly to be used as a classification for
      the bbcode input when evaluating parent-child tag relationships
    */
        bbcode: {
			//Only included for backward compatibility. Can safely be removed
            openTag: function(params, content) {
                return ''
            },
            closeTag: function(params, content) {
                return ''
            },
        },
        center: centerSpec,
        centre: centerSpec,
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
         font: {
           openTag: function(params,content) {

             var faceCode = params || "inherit";
             fontFacePattern.lastIndex = 0;
             if ( !fontFacePattern.test( faceCode ) ) {
               faceCode = "inherit";
             }
             return '<span style="font-family:' + faceCode + '">';
           },
           closeTag: function(params,content) {
             return '</span>';
           }
         },
        i: {
            openTag: function(params, content) {
                return '<span class="bb-i">'
            },
            closeTag: function(params, content) {
                return '</span>'
            },
        },
        justify: {
            trimContents: true,
            openTag: function(params, content) {
                return '<div class="bb-justify">'
            },
            closeTag: function(params, content) {
                return '</div>'
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
            openTag: function(params, content) {
                return '<ul class="bb-list" style="white-space: normal;">'
            },
            closeTag: function(params, content) {
                return '</ul>'
            },
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
            openTag: function(params, content) {
                return '<blockquote class="bb-quote">'
            },
            closeTag: function(params, content) {
                var html = ''
                if (params) {
                    // params starts with '=' unless user messed up.
                    // e.g. '=@Mahz' or '=some guy'
                    if (
                        params.charAt(0) === '@' &&
                        params.length > 1
                    ) {
                        // This is a @uname mention
                        var uname = params.slice(1)
                        html += '<footer>[@' + uname + ']</footer>'
                    } else {
                        var source = params
                        html += '<footer>' + source + '</footer>'
                    }
                }
                html = html + '</blockquote>'
                return html
            },
        },
        right: {
            trimContents: true,
            openTag: function(params, content) {
                return '<div class="bb-right">'
            },
            closeTag: function(params, content) {
                return '</div>'
            },
        },
        s: {
            openTag: function(params, content) {
                return '<span class="bb-s">'
            },
            closeTag: function(params, content) {
                return '</span>'
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
            openTag: function(params, content) {
                return '<sub>'
            },
            closeTag: function(params, content) {
                return '</sub>'
            },
        },
        sup: {
            openTag: function(params, content) {
                return '<sup>'
            },
            closeTag: function(params, content) {
                return '</sup>'
            },
        },
        table: {
            openTag: function(params, content) {
                if (params === 'bordered')
                    return '<div class="table-responsive"><table class="bb-table table table-bordered">'
                return '<div class="table-responsive"><table class="bb-table table">'
            },
            closeTag: function(params, content) {
                isFirstTableRow = true
                return '</table></div>'
            },
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
            openTag: function(params, content, tagStack, errorQueue) {
                let parentTag, foundParent = false
				if(tagStack.length > 1){
					//If more than just us on the stack
					parentTag = tagStack[tagStack.length - 2].tag
					//Grab .tag because the tag stack is strucured {tag, tagData}
				}
				for(let i = 0; i < this.restrictParentsTo.length; i++){
					//Enumerate through acceptable parent list. Faster than for-in
					if(this.restrictParentsTo[i] == parentTag){
						foundParent = true
					}
				}
				if(!foundParent){
					errorQueue.push('The only acceptable parents of the tag \'cell\' include: ' + this.restrictParentsTo)
					return '<td>'
				}

                var classNames = [''],
                    status
                // Determine the status if one is given.
                switch (params) {
                    case 'active':
                        status = 'active'
                        break
                    case 'success':
                        status = 'success'
                        break
                    case 'warning':
                        status = 'warning'
                        break
                    case 'danger':
                        status = 'danger'
                        break
                    case 'info':
                        status = 'info'
                        break
                    default:
                        break
                }
                classNames.push('bb-td')
                if (status)
                    classNames = classNames.concat([status, 'bb-' + status])
                return '<td class="' + classNames.join(' ') + '">'
            },
            closeTag: function(params, content) {
                if (isFirstTableRow) return '</th>'
                return '</td>'
            },
            restrictParentsTo: ['row'],
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
            openTag: function(params, content, tagStack, errorQueue) {				
				let parentTag, foundParent = false
				if(tagStack.length > 1){
					//If more than just us on the stack
					parentTag = tagStack[tagStack.length - 2].tag
					//Grab .tag because the tag stack is strucured {tag, tagData}
				}
				for(let i = 0; i < this.restrictParentsTo.length; i++){
					//Enumerate through acceptable parent list. Faster than for-in
					if(this.restrictParentsTo[i] == parentTag){
						foundParent = true
					}
				}
				if(!foundParent){
					errorQueue.push('The only acceptable parents of the tag \'row\' include: ' + this.restrictParentsTo)
					return '<tr>'
				}
				if (isFirstTableRow) {
                    return '<thead class="bb-thead"><tr class="bb-tr">'
                }
                var classNames = [''],
                    status
                // Determine the status if one is given.
                switch (params) {
                    case 'active':
                        status = 'active'
                        break
                    case 'success':
                        status = 'success'
                        break
                    case 'warning':
                        status = 'warning'
                        break
                    case 'danger':
                        status = 'danger'
                        break
                    case 'info':
                        status = 'info'
                        break
                    default:
                        break
                }
                classNames.push('bb-tr')
                if (status)
                    classNames = classNames.concat([status, 'bb-' + status])
                return '<tr class="' + classNames.join(' ') + '">'
            },
            closeTag: function(params, content) {
                var html
                if (isFirstTableRow) html = '</tr></thead>'
                else html = '</tr>'
                isFirstTableRow = false
                return html
            },
            restrictParentsTo: ['table']
        },
        u: {
            openTag: function(params, content) {
                return '<span class="bb-u">'
            },
            closeTag: function(params, content) {
                return '</span>'
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
			urlErrorStack: [],
            openTag: function(params, content, tagStack, errorQueue) {
                var myUrl

                if (!params) {
                    myUrl = content.trim().replace(/<.*?>/g, '')
                } else {
                    myUrl = params
                        .trim()
                }

                if (
                    myUrl.indexOf('http://') !== 0 &&
					myUrl.indexOf('https://') !== 0 &&
                    myUrl.indexOf('ftp://') !== 0
                ) {
                    // they don't have a valid protocol at the start, so add one [#63]
                    myUrl = 'http://' + myUrl
                }

                urlPattern.lastIndex = 0
                if (!urlPattern.test(myUrl)) {
                    this.urlErrorStack.push(true)
                    errorQueue.push('One of your [url] tags has an invalid url')
                    if (params) return '&#91;url=' + myUrl + '&#93;'
                    else return '&#91;url&#93;'
                }

                // dumb way to see if user is linking internally or externally
                // keep synced with Autolinker#replaceFn definedin this file
				this.urlErrorStack.push(false)
				//If we reach this point, it is a valid URL
                if (/^((https?:\/\/)?roleplayerguild.com)/i.test(myUrl)) {
                    // internal link
                    return '<a href="' + myUrl + '">'
                } else {
                    // external link
                    return (
                        '<a target="_blank" rel="nofollow noopener" href="' +
                        myUrl +
                        '">'
                    )
                }
            },
            closeTag: function(params, content) {
                return this.urlErrorStack.pop() ? '&#91;/url&#93;' : '</a>'
            },
        },
        /*
      The [*] tag is special since the user does not define a closing [/*] tag when writing their bbcode.
      Instead this module parses the code and adds the closing [/*] tag in for them. None of the tags you
      add will act like this and this tag is an exception to the others.
    */
        '*': {	
            trimContents: true,
            openTag: function(params, content, tagStack, errorQueue) {
				let parentTag, foundParent = false
				if(tagStack.length > 1){
					//If more than just us on the stack
					parentTag = tagStack[tagStack.length - 2].tag
					//Grab .tag because the tag stack is strucured {tag, tagData}
				}
				for(let i = 0; i < this.restrictParentsTo.length; i++){
					//Enumerate through acceptable parent list. Faster than for-in
					if(this.restrictParentsTo[i] == parentTag){
						foundParent = true
					}
				}
				if(!foundParent){
					errorQueue.push('The only acceptable parents of the tag \'*\' include: ' + this.restrictParentsTo)
					return '<tr>'
				}
				//Return li no matter what
                return '<li>'
            },
            closeTag: function(params, content) {
                return '</li>'
            },
            restrictParentsTo: ['list'] //, 'ul', 'ol'], These are now unused
        },
    }

    /*
    The star tag [*] is special in that it does not use a closing tag. Since this parser requires that tags to have a closing
    tag, we must pre-process the input and add in closing tags [/*] for the star tag.
    We have a little leverage in that we know the text we're processing wont contain the <> characters (they have been
    changed into their HTML entity form to prevent XSS and code injection), so we can use those characters as markers to
    help us define boundaries and figure out where to place the [/*] tags.
  */
    function fixStarTag(text) {
        text = text.replace(
            /\[(?!\*[ =\]]|list([ =][^\]]*)?\]|\/list[\]])/gi,
            '<'
        )
        text = text.replace(/\[(?=list([ =][^\]]*)?\]|\/list[\]])/gi, '>')

        while (
            text !==
            (text = text.replace(
                />list([ =][^\]]*)?\]([^>]*?)(>\/list])/gi,
                function(matchStr, contents, endTag) {
                    var innerListTxt = matchStr
                    while (
                        innerListTxt !==
                        (innerListTxt = innerListTxt.replace(
                            /\[\*\]([^\[]*?)(\[\*\]|>\/list])/i,
                            function(matchStr, contents, endTag) {
                                if (endTag.toLowerCase() === '>/list]') {
                                    endTag = '</*]</list]'
                                } else {
                                    endTag = '</*][*]'
                                }
                                return '<*]' + contents + endTag
                            }
                        ))
                    );

                    innerListTxt = innerListTxt.replace(/>/g, '<')
                    return innerListTxt
                }
            ))
        );

        // add ['s for our tags back in
        text = text.replace(/</g, '[')
        return text
    }

	function regexEscapeList(replaceList) {
		//Makes every string in a list regex-safe
		for(let i in replaceList){
			replaceList[i] = replaceList[i].replace(/[\\^$*+?.()|[\]{}]/g, '\\$&');
		}
		return replaceList
	}

	let stopList = regexEscapeList(Object.keys(stopTags))
	//Noparse tags
	let allTags = regexEscapeList(Object.keys(tags))
	//Grab all tag [pairs]
	//Regular tags with opening and closing versions
	let singleList = regexEscapeList(Object.keys(singleTags))
	//Tags that don't have a closing counterpart
	allTags = allTags.concat(stopList)
	allTags = allTags.concat(singleList)
	
	function onMisalignedTags(errorQueue = []){
		errorQueue.push('Some tags appear to be misaligned')
	}
	function processTag(tag, data = false, tagStack = [], errorQueue = []){
		if(tags[tag]){
			return tags[tag].openTag(data, null, tagStack, errorQueue)
		}
		else if(singleTags[tag]){
			return singleTags[tag].openTag(data, null, tagStack, errorQueue)
		}
		else{
			return ''
		}
	}
	function processCloseTag(tag, data = false, tagStack = [], errorQueue = []){
		if(tags[tag]){
			return tags[tag].closeTag(data, null, tagStack, errorQueue)
		}
		else{
			return ''
		}
	}
	function findClosingNoParse(tag, message, data = false, tagStack = [], errorQueue = []){
		let closeFinder = new RegExp('(?<=\\[/)(' + tag + ')(?=\\])', '')
		let endResult = closeFinder.exec(message)
		if(!endResult){
			//if the noparse tag isn't closed
			onMisalignedTags(errorQueue)
			return [message.length, message]
		}
		else{
			let innerContent = message.slice(0, endResult.index - 2)
			//We have no idea how the tag wants to handle the inner data, so that's done in the tag functions themselves.
			return [endResult.index - 2, stopTags[tag].openTag(data, innerContent, tagStack, errorQueue) + stopTags[tag].closeTag(data, innerContent, tagStack, errorQueue)]
			//Return the index of the end of the content (accounting for the [/)
		}
	}


	let tagRegex = new RegExp('(?<=\\[)(' + allTags.join('|') + ')(\\s*=.*?)?(?=\\])', 'i')
	let endTagRegex = new RegExp('(?<=\\[/)(' + allTags.join('|') + ')(?=\\])', 'i')
	//Positive lookbehind and lookahead to grab the tag we care about


	function getTagAndOptionalData(tagSearch){
		//Grab the two capturing groups (tag and the tag data) and return them. Return empty by default
		let mainTag = ''
		let innerData = ''
		if(tagSearch){
			mainTag = tagSearch[1].toLowerCase()
			//Grab main tag
			if(tagSearch[2]){
				innerData = tagSearch[2].slice(1,).trim()
				//Also grab inner data if(it exists but remove = sign
			}
		}
		return [mainTag, innerData]
	}
		

	function parseBBCode(message, errorQueue){
		let contentEnd = 0
		//This value changes as we scan through the tag set
		let rebuiltString = ''
		let tagStack = []
		while(true){
			//Loop until we have traversed every tag in this level
			let result = tagRegex.exec(message.slice(contentEnd,))
			//We measure from contentEnd because we need to know where to search from when two tags are embedded on the same level
			let endResult = endTagRegex.exec(message.slice(contentEnd,))
			//We grab both the next start and end tags and see which comes first
			if(result && (!endResult || endResult.index > result.index)){
				//if our next tag is an open tag
				let [tag, tagData] = getTagAndOptionalData(result)
				tagStack.push({'tag':tag, 'data':tagData})
				//if there is no = in the tag, tagData will be null
				rebuiltString += message.slice(contentEnd, contentEnd + result.index - 1)
				rebuiltString += processTag(tag, tagData, tagStack, errorQueue)
				//Add everything up to and including the tag to the rebuilt string. We have to remember that results is always going to be offset by contentEnd
				contentEnd += result.index + result[0].length + 1
				if(singleList.includes(tag)){
					tagStack.pop()
				}
				else if(stopList.includes(tag)){
					//if we encounter a noparse tag
					let [endIndex, embeddedContent] = findClosingNoParse(tag, message.slice(contentEnd,), tagData, errorQueue)
					contentEnd += endIndex
					rebuiltString += embeddedContent
					//We have to add the index of the result as well
				}
			}
			else if(endResult){
				//if the next tag is a closing one
				rebuiltString += message.slice(contentEnd, contentEnd + endResult.index - 2)
				let endTag = endResult[0].toLowerCase()
				let parserEnd = endResult.index + endResult[0].length + 1
				if(tagStack.length < 1){
					//if this is an unpaired closing tag, treat it as text and keep going
					rebuiltString += message.slice(contentEnd, contentEnd + parserEnd)
					contentEnd += parserEnd
					continue
				}
				else if(endTag != tagStack[tagStack.length - 1].tag){
					//if our tags don't match
					onMisalignedTags(errorQueue)
				}
				endData = tagStack.pop()
				//If the end tag is a mismatch, force them to align to not break the post
				rebuiltString += processCloseTag(endData.tag, endData.data, tagStack, errorQueue)
				contentEnd += parserEnd
			}
			else{
				//if we're out of tags
				if(tagStack.length > 0){
					//if we don't have enough closing tags
					onMisalignedTags(errorQueue)
					while(tagStack.length > 0){
						phantomData = tagStack.pop()
						rebuiltString += processCloseTag(phantomData.tag, phantomData.data, tagStack, errorQueue)
						//Finish adding missing ending tags
					}
				}
				rebuiltString += message.slice(contentEnd,)
				break
			}
		}
		return rebuiltString
	}


	

    // -----------------------------------------------------------------------------
    // public functions
    // -----------------------------------------------------------------------------

    // API, Expose all available tags
    me.tags = function() {
        return tags
    }

    // API

    me.process = function(config) {
        var ret = { html: '', error: false },
            errQueue = []

		isFirstTableRow = true //Have to reset this global variable until I figure out an elegant way to delete it
        config.text = escapeHtml(config.text) //Escape dangerous characters

        config.text = fixStarTag(config.text) // add in closing tags for the [*] tag

        ret.html = parseBBCode(config.text, errQueue)



        // Wrap >greentext with styling
        ret.html = replaceGreenText(ret.html)

        if (config.addInLineBreaks) {
            ret.html =	
                '<div style="white-space:pre-wrap;">' + ret.html + '</div>'
        }

        // Replace smilie codes with <img>s
        ret.html = replaceSmilies(ret.html)

        // Replace [@Mentions] with a link
        ret.html = replaceMentions(ret.html)

        ret.html = ret.html.replace(/\t/g, '&#9;')
        ret.html = ret.html.replace(/\r/g, '')
        ret.html = ret.html.replace(/\n{2,}/g, '\n\n')
        ret.html = ret.html.replace(/\n/g, '<br>')

		errQueue = makeUnique(errQueue)
        ret.error = errQueue.length !== 0
        ret.errorQueue = errQueue

        return ret
    }

    return me
})()

var autolinkerOpts = {
    stripPrefix: true,
    truncate: 40,
    email: false,
    phone: false,
    twitter: false,
    hashtag: false,
    newWindow: false,
    // keep synced with [url] logic
    replaceFn: function(match) {
        //var tag = autolinker.getTagBuilder().build(match);
        var tag = match.buildTag()
        // dumb way to see if user is linking internally or externally
        if (!/^((https?:\/\/)?roleplayerguild.com)/i.test(match.getAnchorHref())) {
            tag.setAttr('rel', 'nofollow noopener').setAttr('target', '_blank')
        }
        return tag
    },
}

// Allow bbcode_editor.js to access it
if (isBrowser) {
    window.autolinkerOpts = autolinkerOpts
}

if (typeof window === 'undefined') {
    // We're on the server, so export module
    module.exports = function(markup) {
        var result,
            start = Date.now()
        result = XBBCODE.process({ text: markup, addInLineBreaks: true })
        // Linkify URLs
        var html = Autolinker.link(result.html, autolinkerOpts)
        var diff = Date.now() - start
        // console.log(util.format('[bbcode.js] Rendered %s chars of BBCode in %sms', markup.length, diff));
        // console.log('[bbcode.js] result.error:', result.error);
        // console.log('[bbcode.js] result.errorQueue',result.errorQueue);

        return html
    }
} else {
    // We're on the client so export to window
    window.bbcode = function(markup) {
        var result = XBBCODE.process({ text: markup, addInLineBreaks: true })
        var html = Autolinker.link(result.html, autolinkerOpts)
        return html
    }
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
