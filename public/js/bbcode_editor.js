var w;
(function( $ ){

  // commafy(10) -> 10
  // commafy(1000000) -> 1,000,000
  function commafy(n) {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  var buttons = {
    'bb-b': {
      name: 'bb-b',
      title: 'Bold',
      hotkey: 'Ctrl+B',
      icon: 'fa fa-bold',
      callback: function(e) {
        var tag = 'b';
        var selected = e.getSelection();
        if (selected.length === 0) {
          e.replaceSelection('['+tag+'][/'+tag+']');
          var newPos = selected.end + tag.length + 2;
          e.setSelection(newPos, newPos);
        } else {
          var chunk = '['+tag+']' + selected.text + '[/'+tag+']';
          e.replaceSelection(chunk);
          var cursor = selected.start;
          e.setSelection(cursor, cursor+chunk.length);
        }
      }
    },
    'bb-i': {
      name: 'bb-i',
      title: 'Italic',
      hotkey: 'Ctrl+I',
      icon: 'fa fa-italic',
      callback: function(e) {
        var selected = e.getSelection();
        if (selected.length === 0) {
          e.replaceSelection('[i][/i]');
          e.setSelection(selected.end + 3, selected.end + 3);
        } else {
          var chunk = '[i]' + selected.text + '[/i]';
          var cursor;
          e.replaceSelection(chunk);
          cursor = selected.start;
          e.setSelection(cursor, cursor+chunk.length);
        }
      }
    },
    'bb-u': {
      name: 'bb-u',
      title: 'Underline',
      icon: 'fa fa-underline',
      callback: function(e) {
        var selected = e.getSelection();
        if (selected.length === 0) {
          e.replaceSelection('[u][/u]');
          e.setSelection(selected.end + 3, selected.end + 3);
        } else {
          var chunk = '[u]' + selected.text + '[/u]';
          var cursor;
          e.replaceSelection(chunk);
          cursor = selected.start;
          e.setSelection(cursor, cursor+chunk.length);
        }
      }
    },
    'bb-s': {
      name: 'bb-s',
      title: 'Strike-through',
      icon: 'fa fa-strikethrough',
      callback: function(e) {
        var selected = e.getSelection();
        if (selected.length === 0) {
          e.replaceSelection('[s][/s]');
          e.setSelection(selected.end + 3, selected.end + 3);
        } else {
          var chunk = '[s]' + selected.text + '[/s]';
          var cursor;
          e.replaceSelection(chunk);
          cursor = selected.start;
          e.setSelection(cursor, cursor+chunk.length);
        }
      }
    },
    'bb-url': {
      name: 'bb-url',
      title: 'URL/Link',
      hotkey: 'Ctrl+L',
      icon: 'fa fa-chain',
      callback: function(e) {
        var tag = 'url';
        var selected = e.getSelection();
        if (selected.length === 0) {
          e.replaceSelection('['+tag+'][/'+tag+']');
          var newPos = selected.end + tag.length + 2;
          e.setSelection(newPos, newPos);
        } else {
          var chunk = '['+tag+']' + selected.text + '[/'+tag+']';
          e.replaceSelection(chunk);
          var cursor = selected.start;
          e.setSelection(cursor, cursor+chunk.length);
        }
      }
    },
    'bb-img': {
      name: 'bb-img',
      title: 'Image',
      hotkey: 'Ctrl+G',
      icon: 'fa fa-image',
      callback: function(e) {
        var tag = 'img';
        var selected = e.getSelection();
        if (selected.length === 0) {
          e.replaceSelection('['+tag+'][/'+tag+']');
          var newPos = selected.end + tag.length + 2;
          e.setSelection(newPos, newPos);
        } else {
          var chunk = '['+tag+']' + selected.text + '[/'+tag+']';
          e.replaceSelection(chunk);
          var cursor = selected.start;
          e.setSelection(cursor, cursor+chunk.length);
        }
      }
    },
    'bb-quote': {
      name: 'bb-quote',
      title: 'Quote',
      hotkey: 'Ctrl+Q',
      icon: 'fa fa-quote-left',
      callback: function(e) {
        var tag = 'quote';
        var selected = e.getSelection();
        if (selected.length === 0) {
          e.replaceSelection('['+tag+'][/'+tag+']');
          var newPos = selected.end + tag.length + 2;
          e.setSelection(newPos, newPos);
        } else {
          var chunk = '['+tag+']' + selected.text + '[/'+tag+']';
          e.replaceSelection(chunk);
          var cursor = selected.start;
          e.setSelection(cursor, cursor+chunk.length);
        }
      }
    },
    'bb-hider': {
      name: 'bb-hider',
      title: 'Hider',
      icon: 'fa fa-eye-slash',
      callback: function(e) {
        var selected = e.getSelection();
        if (selected.length === 0) {
          e.replaceSelection('\n[hider=My Hider]\n\n[/hider]\n');
          var newPos = selected.end + 18;
          e.setSelection(newPos, newPos);
        } else {
          var chunk = '\n[hider=My Hider]\n' + selected.text + '\n[/hider]\n';
          e.replaceSelection(chunk);
          var cursor = selected.start;
          // cursor+1 so that the initial \n is not selected
          e.setSelection(cursor+1, cursor+chunk.length);
        }
      }
    },
    'bb-mention': {
      name: 'bb-mention',
      title: 'Mention User',
      icon: 'fa fa-at',
      callback: function(e) {
        var tag = 'img';
        var selected = e.getSelection();
        if (selected.length === 0) {
          e.replaceSelection('[@Username]');
          e.setSelection(selected.start+2, selected.start+10);
        } else {
          var chunk = '[@' + selected.text.trim() + ']';
          e.replaceSelection(chunk);
          var cursor = selected.start;
          e.setSelection(cursor, cursor+chunk.length);
        }
      }
    },
    'bb-tabs': {
      name: 'bb-tabs',
      title: 'Tabs',
      icon: 'fa fa-folder',
      callback: function(e) {
        var selected = e.getSelection();
        var cursor = selected.start;
        e.setSelection(cursor, cursor);
        var markup = '\n[tabs]\n[tab=Hello]\n:)\n[/tab]\n[tab=Goodbye]\n:(\n[/tab]\n[/tabs]\n';
        e.replaceSelection(markup);
        e.setSelection(cursor+1, cursor+markup.length);
      }
    },
    'bb-color': {
      name: 'bb-color',
      title: 'Font Color',
      icon: 'fa fa-eyedropper',
      toggle: true,
      callback: function(e) {
        console.log('Clicked');
      }
    },
    'bb-preview': {
      name: 'bb-preview',
      toggle: true,
      title: 'Preview',
      icon: 'fa fa-search',
      btnClass: 'btn btn-primary btn-sm',
      btnText: 'Preview',
      callback: function(e) {
        if (e.$isPreview === false) {
          e.showPreview();
          e.enableButtons('bb-preview');
        } else {
          e.hidePreview();
          e.$editor.find('.bbcode-errors p').html('');
          e.$editor.find('.bbcode-errors ul').html('');
        }
      }
    }
  };

  $.fn.bbcode = function(opts) {
    var $this = $(this);

    opts = opts || {};

    if (!opts.charLimit)
      console.error('charLimit not set on editor');

    var charLimit = parseInt(opts.charLimit);

    // The Markdown editor instance will be stored in $M so I can access
    // its state easily from anywhere in this module.
    // I assign it in the editor's "show" event when it loads which seems to
    // always happen before everything else. Probably not seeing a simpler
    // more obvious strategy to fetch the edit instance.
    // Note: $M is the same object that markdown-bootstrap exposes
    // with the arg it passes to its callbacks like onPreview and onSave.
    // console.dir($M) it for more info. For example, $M.$editor gets
    // the entire editor container. $M.$element gets the textarea.
    // And there's all sorts of props/fns available on this object.
    // More info: http://www.codingdrama.com/bootstrap-markdown/
    var $M;

    // `opts` arg will be merged into this
    var defaults = {
      resize: 'vertical',
      height: 350,
      iconlibrary: 'fa',
      onChange: function(e) {
        var count = e.getContent().length;
        e.$editor.find('.char-count .current').text(commafy(count));
      },
      onShow: function(e) {
        console.log('show');
        $M = e;
      },
      onPreview: function(e) {
        // if (!e.isDirty())
        //   return e.getContent();

        var result = XBBCODE.process({
          text: e.getContent(),
          addInLineBreaks: true
        });

        // Display errs in editor footer if there are any
        e.$editor.find('.bbcode-errors p').html('Errors: ');

        if (result.error) {
          var html = '';
          html = html + result.errorQueue.map(function(msg) {
            return '<li>' + msg + '</li>';
          }).join('');
          e.$editor.find('.bbcode-errors ul').html(html);
        } else {
          e.$editor.find('.bbcode-errors ul').html('');
          e.$editor.find('.bbcode-errors p').append(' <span class="label label-success">None</span>');
        }

        return result.html;
      },
      buttons: [[]],
      // hiddenButtons: ['cmdBold', 'cmdItalic', 'cmdHeading',
      //                 'cmdUrl', 'cmdImage', 'cmdPreview',
      //                 'cmdList', 'cmdList0', 'cmdCode', 'cmdQuote'],
      additionalButtons: [
        [
          {name: 'bbcode1',
           data: [buttons['bb-b'], buttons['bb-i'], buttons['bb-u'],
                  buttons['bb-s'], buttons['bb-color']]},
          {name: 'bbcode2',
           data: [buttons['bb-url'], buttons['bb-img']]},
          {name: 'bbcode3',
           data: [buttons['bb-quote'],
                  buttons['bb-hider'],
                  buttons['bb-mention']
                  //,buttons['bb-tabs']
                 ]},
          {name: 'bbcode4',
           data: [buttons['bb-preview']]}
        ]
      ],
      footer: '<div class="bbcode-errors">'+
              '  <div class="char-count">'+
              '    <span class="current">--</span>'+
              '    / <span class="limit">'+ (charLimit ? commafy(charLimit) : '--') +'</span> chars'+
              '  </div>'+
              '  <p></p>'+
              '  <ul style="color: red;"></ul>'+
              '</div>'
    };

    opts = $.extend(defaults, opts);

    // Activate the editor
    $this.markdown(opts);

    // Hook up color button
    var colors = [
      // Pastel
      ['f7976a', 'f9ad81', 'fdc68a', 'fff79a',
       'c4df9b', 'a2d39c', '82ca9d', '7bcdc8',
       '6ecff6', '7ea7d8', '8493ca', '8882be',
       'a187be', 'bc8dbf', 'f49ac2', 'f6989d'],
      // Full
      ['ed1c24', 'f26522', 'f7941d', 'fff200',
       '8dc73f', '39b54a', '00a651', '00a99d',
       '00aeef', '0072bc', '0054a6', '2e3192',
       '662d91', '92278f', 'ec008c', 'ed145b'],
      // Dark
      ['9e0b0f', 'a0410d', 'a36209', 'aba000',
       '598527', '1a7b30', '007236', '00746b',
       '0076a3', '004b80', '003471', '1b1464',
       '440e62', '630460', '9e005d', '9e0039']
    ];
    var content = '<div class="bb-color-editor">';
    content = content + colors.map(function(row) {
      var html = '<div class="bb-color-row">';
      html = html + row.map(function(hex) {
        return '<a href="#" class="bb-color-swatch" '+
          '   data-hex="'+ hex + '" '+
          '   style="background-color: #'+hex+'"></a>'
      }).join('');
      return html + '</div>';
    }).join('');
    content = content + '</div>';

    $M.$editor.find('button[title="Font Color"]').popover({
      placement: 'auto top',
      content: content,
      container: 'body',
      html: true
    }).on('shown.bs.popover', function() {
      var self = this;
      var id = $(this).attr('aria-describedby');
      var $popover = $('#' + id);
      $popover.find('.bb-color-swatch').on('click', function(e) {
        e.preventDefault();
        var hex = $(this).attr('data-hex');

        var selected = $M.getSelection();
        if (selected.length === 0) {
          $M.replaceSelection('[color='+hex+'][/color]');
          var newPos = selected.start + 14;
          $M.setSelection(newPos, newPos);
        } else {
          var chunk = '[color='+hex+']' + selected.text + '[/color]';
          var cursor;
          $M.replaceSelection(chunk);
          cursor = selected.start;
          $M.setSelection(cursor, cursor+chunk.length);
        }
        // Get rid of popover once color is selected
        // $(self).popover('hide');
      });
    });

    // Expose $M for debugging
    window.$M = $M;

    return this;
  };
})( jQuery );
