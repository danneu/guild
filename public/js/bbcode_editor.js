var w;
(function( $ ){

  var buttons = {
    'bb-b': {
      name: 'bb-b',
      title: 'Bold',
      icon: 'fa fa-bold',
      callback: function(e) {
        var tag = 'b';
        var selected = e.getSelection();
        if (selected.length == 0) {
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
      icon: 'fa fa-italic',
      callback: function(e) {
        var selected = e.getSelection();
        if (selected.length == 0) {
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
        if (selected.length == 0) {
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
        if (selected.length == 0) {
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
      title: 'URL',
      icon: 'fa fa-chain',
      callback: function(e) {
        var tag = 'url';
        var selected = e.getSelection();
        if (selected.length == 0) {
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
      icon: 'fa fa-image',
      callback: function(e) {
        var tag = 'img';
        var selected = e.getSelection();
        if (selected.length == 0) {
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
      icon: 'fa fa-quote-left',
      callback: function(e) {
        var tag = 'quote';
        var selected = e.getSelection();
        if (selected.length == 0) {
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
        if (selected.length == 0) {
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
  };

  $.fn.bbcode = function(opts) {
    var $this = $(this);

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
      onShow: function(e) {
        console.log('show');
        $M = e;
      },
      onPreview: function(e) {
        if (!e.isDirty())
          return e.getContent();
        return XBBCODE.process({
          text: e.getContent(),
          addInLineBreaks: true
        }).html;
      },
      hiddenButtons: ['cmdBold', 'cmdItalic', 'cmdHeading',
                      'cmdUrl', 'cmdImage',
                      'cmdList', 'cmdList0', 'cmdCode', 'cmdQuote'],
      additionalButtons: [
        [
          {name: 'bbcode1',
           data: [buttons['bb-b'], buttons['bb-i'], buttons['bb-u'],
                  buttons['bb-s'], buttons['bb-color']]},
          {name: 'bbcode2',
           data: [buttons['bb-url'], buttons['bb-img']]},
          {name: 'bbcode3',
           data: [buttons['bb-quote'], buttons['bb-hider'], buttons['bb-tabs']]}
        ]
      ]
    };

    opts = $.extend(defaults, opts);

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
      placement: 'auto bottom',
      content: content,
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
