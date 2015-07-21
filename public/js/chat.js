'use strict';

////////////////////////////////////////////////////////////

var config = {
  HISTORY_SIZE: 100
};

////////////////////////////////////////////////////////////

var el = React.DOM;

var hex = {
  'red': '#e74c3c'
};

var helpers = {};
helpers.isTextValid = function(text) {
  return text.trim().length >= 1 && text.trim().length <= 300;
};
// String (Date JSON) -> String
helpers.formatMessageDate = function(dateJson) {
  var date = new Date(dateJson);
  return _.padLeft(date.getHours().toString(), 2, '0') +
    ':' +
    _.padLeft(date.getMinutes().toString(), 2, '0');
};
helpers.generateUuid = function() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random()*16|0, v = c == 'x' ? r : (r&0x3|0x8);
    return v.toString(16);
  });
};
helpers.slugifyUname = function(uname) {
  var slug = uname
    .trim()
    .toLowerCase()
    .replace(/ /g, '-');

  return slug;
};
helpers.escapeHtml = function(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};
helpers.safeAutolink = function(text) {
  return Autolinker.link(helpers.escapeHtml(text), autolinkerOpts);
};
helpers.toMD5HexColor = function(s) {
  return '#' + md5(s).slice(0, 6);
};
helpers.lightenColor = function(color, percent) {

    var R = parseInt(color.substring(1,3),16);
    var G = parseInt(color.substring(3,5),16);
    var B = parseInt(color.substring(5,7),16);

    R = parseInt(R * (100 + percent) / 100);
    G = parseInt(G * (100 + percent) / 100);
    B = parseInt(B * (100 + percent) / 100);

    R = (R<255)?R:255;
    G = (G<255)?G:255;
    B = (B<255)?B:255;

    var RR = ((R.toString(16).length==1)?"0"+R.toString(16):R.toString(16));
    var GG = ((G.toString(16).length==1)?"0"+G.toString(16):G.toString(16));
    var BB = ((B.toString(16).length==1)?"0"+B.toString(16):B.toString(16));

    return "#"+RR+GG+BB;
};
helpers.shadeBlend = function(p,c0,c1) {
    var n=p<0?p*-1:p,u=Math.round,w=parseInt;
    if(c0.length>7){
        var f=c0.split(","),t=(c1?c1:p<0?"rgb(0,0,0)":"rgb(255,255,255)").split(","),R=w(f[0].slice(4)),G=w(f[1]),B=w(f[2]);
        return "rgb("+(u((w(t[0].slice(4))-R)*n)+R)+","+(u((w(t[1])-G)*n)+G)+","+(u((w(t[2])-B)*n)+B)+")"
    }else{
        var f=w(c0.slice(1),16),t=w((c1?c1:p<0?"#000000":"#FFFFFF").slice(1),16),R1=f>>16,G1=f>>8&0x00FF,B1=f&0x0000FF;
        return "#"+(0x1000000+(u(((t>>16)-R1)*n)+R1)*0x10000+(u(((t>>8&0x00FF)-G1)*n)+G1)*0x100+(u(((t&0x0000FF)-B1)*n)+B1)).toString(16).slice(1)
    }
};
helpers.extractMentions = function(text) {
  var re = /\[@([a-z0-9 ]+)\]/gi;

  var unames = [];

  var match;
  while (match = re.exec(text)) {
    unames.push(match[1].toLowerCase().trim());
  }

  return _.uniq(unames);
};

// props:
// - muteList
// - receivedServerPayload
var MuteList = React.createClass({
  shouldComponentUpdate: function(nextProps, nextState) {
    var currLength = _.keys(this.props.muteList).length;
    var nextLength = _.keys(nextProps.muteList).length;

    if (currLength !== nextLength) {
      return true;
    }

    if (this.props.receivedServerPayload !== nextProps.receivedServerPayload) {
      return true;
    }

    return false;
  },
  componentDidUpdate: function() {
    $("abbr.timeago").timeago();

    console.log('[MuteList] updated');
  },
  render: function() {
    return el.div(
      null,
      'Mute list: ' + _.keys(this.props.muteList).length,
      el.ul(
        {className: 'list-unstyled'},
        _.pairs(this.props.muteList).map(function(pair) {
          var uname = pair[0];
          var duration = pair[1];
          if (duration) {
            duration = new Date(pair[1]);
          }
          return el.li(
            { key: uname },
            el.a(
              {href: '/users/' + helpers.slugifyUname(uname)},
              uname
            ),
            duration === null ?
              ' - ' :
              el.span({ className: 'text-muted' }, ' - Expires '),
            duration === null ?
              el.span({className: 'text-muted'}, 'Forever') :
              el.abbr(
                {
                  className: 'timeago',
                  title: duration.toISOString()
                },
                duration.toISOString()
              )
          );
        })
      )
    );
  }
});

// props: {
//   userList: { Uname -> User }
//   receivedServerPayload: Bool
//   onUnameClick: fn
// }
var UserList = React.createClass({
  shouldComponentUpdate: function(nextProps, nextState) {
    var currLength = _.keys(this.props.userList).length;
    var nextLength = _.keys(nextProps.userList).length;

    if (currLength !== nextLength) {
      return true;
    }

    if (this.props.receivedServerPayload !== nextProps.receivedServerPayload) {
      return true;
    }

    return false;
  },
  componentDidUpdate: function() {
    console.log('[UserList] Updating');
  },
  render: function() {
    return el.div(
      null,
      'Users online: ',
      !this.props.receivedServerPayload ?
        '--' :
        _.keys(this.props.userList).length,
      !this.props.receivedServerPayload ?
        '' :
        el.ul(
          {className: 'list-unstyled'},
          _.values(this.props.userList).map(function(u) {
            return el.li(
              { key: u.uname },
              u.role === 'admin' ?
                el.span(
                  {
                    className: 'glyphicon glyphicon-star',
                    style: {
                      color: '#f1c40f'
                    }
                  }
                ) : '',
              u.role === 'admin' ? ' ' : '',
              el.a(
                {
                  href: 'javascript:void(0)',
                  onClick: this.props.onUnameClick
                },
                u.uname
              ),
              ' ',
              el.a(
                {
                  href: '/users/' + u.slug,
                  className: 'text-muted',
                  target: '_blank',
                  style: {
                    fontSize: '90%'
                  }
                },
                '[profile]'
              )
            );
          }, this)
        )
    );
  }
});

// if currUname is not given, then currUser is guest
helpers.makeMessagePresenter = function(currUname) {
  return function(m) {

    m.id = helpers.generateUuid();

    if (currUname) {
      m.mentions_user = _.contains(
        helpers.extractMentions(m.text), currUname.toLowerCase()
      );
    }

    if (m.user) {
      m.html = replaceSmilies(helpers.safeAutolink(m.text));
    }

    return m;
  };
};

// props:
// - _makeSmilieClickHandler: fn
var SmilieList = React.createClass({
  getInitialState: function() {
    return {
      show: false
    };
  },
  shouldComponentUpdate: function(_, nextState) {
    return this.state.show !== nextState.show;
  },
  _onToggleClick: function() {
    this.setState({ show: !this.state.show });
  },
  render: function() {
    return el.div(
      null,
      el.button(
        {
          type: 'button',
          className: 'btn btn-default btn-xs',
          onClick: this._onToggleClick
        },
        el.img({src: '/img/smile.gif'}),
        ' ',
        this.state.show ? 'Hide Smilies' : 'Show Smilies'
      ),
      el.div(
        {
          style: {
            display: this.state.show ? 'block' : 'none'
          }
        },
        'Click to add: ',
        smilies.map(function(smilieName) {
          return el.div(
            {
              key: smilieName,
              onClick: this.props._makeSmilieClickHandler(smilieName),
              'data-smilie-name': smilieName,
              className: 'smilie-box',
              title: ':' + smilieName,
              style: {
                display: 'inline-block',
                marginRight: '10px'
              }
            },
            el.span(
              {className: 'label label-default'},
              el.img(
                {
                  src: '/smilies/' + smilieName + '.gif',
                  alt: ':' + smilieName
                }
              )
            )
          );
        }, this)
      )
    );
  }
});

var App = React.createClass({
  getInitialState: function() {
    return {
      text: '',
      user: undefined,
      messages: [],
      // String or undefined
      session_id: $('#session-id').attr('data-session-id'),
      socket: undefined,
      userList: {},
      muteList: {},
      receivedServerPayload: false,
      waitingOnServer: false,
      //
      windowIsFocused: true,
      unreadMentions: 0,
      //
      soundEnabled: !localStorage.getItem('chat-sound-disabled')
    };
  },
  componentWillMount: function() {
    var chat_server_url = $('#chat-server-url').attr('data-chat-server-url');
    this.setState({ socket: io(chat_server_url) });
  },
  componentDidMount: function() {
    var self = this;

    window.onfocus = function() {
      self.setState({
        windowIsFocused: true,
        unreadMentions: 0
      }, function() {
        document.title = 'Chat — Roleplayer Guild';
      });
    };
    window.onblur = function() {
      self.setState({ windowIsFocused: false });
    };

    setInterval(function() {
      // Ensure title is sync'd. Should prob just not use setState for this.
      if (self.state.windowIsFocused && document.title[0] !== 'C') {
        document.title = 'Chat — Roleplayer Guild';
        return;
      }

      if (!self.state.windowIsFocused && self.state.unreadMentions > 0) {
        if (document.title[0] === '*') {
          document.title = document.title.slice(1);
        } else {
          document.title = '* ' + document.title;
        }
      }
    }, 500);

    this.state.socket.on('reconnect', function() { console.log('Reconnect'); });
    this.state.socket.on('disconnect', function() { console.log('Disconnect'); });
    this.state.socket.on('user_unmuted', function(uname) {
      //delete self.state.muteList[uname];

      var muteList2 = _.clone(self.state.muteList, true);
      delete muteList2[uname];

      self.setState({
        muteList: muteList2
      });
    });
    this.state.socket.on('user_muted', function(uname, expires_at) {
      if (expires_at) {
        expires_at = new Date(expires_at);
      }
      //self.state.muteList[uname] = expires_at;

      var muteList2 = _.clone(self.state.muteList, true);
      muteList2[uname] = expires_at;

      self.setState({
        muteList: muteList2
      });
    });
    this.state.socket.on('connect', function() {
      console.log('connected');
      self.state.socket.emit('auth', { session_id: self.state.session_id }, function(err, data) {
        if (err) {
          console.log('Error:', err);
          return;
        }
        console.log('server responded to auth with payload:', data);

        var userList = {};
        data.users.forEach(function(u) {
          userList[u.uname] = u;
        });

        data.messages = _.takeRight(data.messages, config.HISTORY_SIZE).map(helpers.makeMessagePresenter(data.user && data.user.uname));

        self.setState({
          user: data.user,
          messages: data.messages,
          userList: userList,
          muteList: data.muteList,
          receivedServerPayload: true
        }, self._scrollChat);
      });

      ////////////////////////////////////////////////////////////

      self.state.socket.off('new_message').on('new_message', function(message) {
        message = helpers.makeMessagePresenter(self.state.user && self.state.user.uname)(message);

        if (message.mentions_user && !self.state.windowIsFocused) {
          self.setState({
            unreadMentions: self.state.unreadMentions + 1
          }, function() {
            document.title = '[' + self.state.unreadMentions + '] Chat — Roleplayer Guild';
          });
        }

        if (message.mentions_user && self.state.soundEnabled) {
          $('#notify-sound').get(0).play();
        }

        var messages = self.state.messages.length === config.HISTORY_SIZE ?
            _.drop(self.state.messages).concat([message]) :
            self.state.messages.concat([message]);

        self.setState({
          messages: messages
        }, function() {
          self._onNewMessage();
        });
      });

      ////////////////////////////////////////////////////////////

      self.state.socket.off('user_joined').on('user_joined', function(user) {
        console.log('[received user_joined]', user.uname);

        var userList2 = _.cloneDeep(self.state.userList);
        userList2[user.uname] = user;

        self.setState({ userList: userList2 });
      });

      ////////////////////////////////////////////////////////////

      self.state.socket.off('user_left').on('user_left', function(user) {
        console.log('[received user_left]', user.uname);

        // Is there a sane way to non-destructively remove a key in JS?
        var userList2 = _.cloneDeep(self.state.userList);
        delete userList2[user.uname];

        self.setState({
          userList: userList2
        });
      });

    });
  },
  _onInputChange: function(e) {
    this.setState({ text: e.target.value });
  },
  _onInputKeyDown: function(e) {
    var ENTER = 13;
    if (e.which === ENTER && this.state.user) {
      this._submitMessage();
    }
  },
  _submitMessage: function() {
    var self = this;

    if (!helpers.isTextValid(this.state.text)) {
      return;
    }

    if (this.state.waitingOnServer) {
      return;
    }

    self.setState({ waitingOnServer: true });

    this.state.socket.emit('new_message', this.state.text, function(errString) {
      self.setState({ waitingOnServer: false });
      if (errString) {
        alert('Error: ' + errString);
        return;
      }
      self.setState({ text:  '' }, function() {
        self.refs.input.getDOMNode().focus();
      });
    });
  },
  _onSoundClick: function() {
    if (this.state.soundEnabled) {
      localStorage.setItem('chat-sound-disabled', 'true');
    } else {
      localStorage.removeItem('chat-sound-disabled');
    }
    this.setState({
      soundEnabled: !this.state.soundEnabled
    });
  },
  // New messages should only force scroll if user is scrolled near the bottom
  // already. This allows users to scroll back to earlier convo without being
  // forced to scroll to bottom when new messages arrive
  _onNewMessage: function() {
    var node = this.refs.chatListRef.getDOMNode();

    // Only scroll if user is within 100 pixels of last message
    var shouldScroll = function() {
      var distanceFromBottom = node.scrollHeight - ($(node).scrollTop() + $(node).innerHeight());
      return distanceFromBottom <= 100;
    };

    if (shouldScroll()) {
      this._scrollChat();
    }
  },
  _scrollChat: function() {
    var node = this.refs.chatListRef.getDOMNode();
    $(node).scrollTop(node.scrollHeight);
  },
  _onUnameClick: function(e) {
    var self = this;
    var uname = ($(e.target).text().trim().replace(/:/, ''));
    this.setState({
      text: this.state.text + '[@' + uname + ']'
    }, function() {
      self.refs.input.getDOMNode().focus();
    });
    e.preventDefault();
  },
  _makeSmilieClickHandler: function(smilieName) {
    var self = this;

    return function() {
      var shouldPad = self.state.text.length > 0 && self.state.text.slice(-1) !== ' ';
      self.setState({
        text: self.state.text +
          (shouldPad ? ' :' + smilieName : ':' + smilieName) + ' '
      }, function() {
        self.refs.input.getDOMNode().focus();
      });
    };
  },
  //
  // Message formatting
  //
  //
  // Lightened. Up = lighter
  // color: helpers.shadeBlend(0.30, helpers.toMD5HexColor(m.user.uname), '#ffffff')
  // color: helpers.lightencolor(helpers.tomd5hexcolor(m.user.uname), 25)
  // color: helpers.lightenColor(helpers.toMD5HexColor(m.user.uname), -25)
  _renderSystemMessage: function(m) {
    return el.code({clasName: 'message-text'}, m.text);
  },
  _renderChatMessage: function(m) {
    return el.span(
      null,
      el.a(
        {
          href: 'javascript:void(0)',
          onClick: this._onUnameClick
        },
        el.code(
          {
            className: 'message-uname',
            style: {
              color: helpers.shadeBlend(0.30, helpers.toMD5HexColor(m.user.uname), '#ffffff')
            }
          },
          m.user && m.user.role === 'admin' ?
            el.span(
              {
                className: 'glyphicon glyphicon-star',
                style: {
                  color: '#f1c40f'
                }
              }
            ) : '',
          m.user && m.user.role === 'admin' ? ' ' : '',
          m.user.uname + ':'
        )
      ),
      el.span(
        {
          className: 'message-text',
          dangerouslySetInnerHTML: {
            __html: ' ' + m.html
          }
        }
      )
    );
  },
  _renderEmoteMessage: function(m) {
    return el.span(
      null,
      el.code(
        {
          className: 'message-uname',
          style: {
            color: helpers.shadeBlend(0.30, helpers.toMD5HexColor(m.user.uname), '#ffffff')
          }
        },
        m.user && m.user.role === 'admin' ?
          el.span(
            {
              className: 'glyphicon glyphicon-star',
              style: {
                color: '#f1c40f'
              }
            }
          ) : '',
        m.user && m.user.role === 'admin' ? ' ' : '',
        el.span(
          null,
          el.a(
            {
              href: 'javascript:void(0)',
              onClick: this._onUnameClick,
              style: {
                color: 'inherit'
              }
            },
            m.user.uname
          ),
          el.span(
            {
              className: 'message-text',
              dangerouslySetInnerHTML: {
                __html: m.html.replace(/^\/me/i, '')
              }
            }
          )
        )
      )
    );
  },
  _renderMessage: function(m) {
    if (m.system) {
      return this._renderSystemMessage(m);
    } else if (m.text.startsWith('/me')) {
      return this._renderEmoteMessage(m);
    } else {
      return this._renderChatMessage(m);
    }
  },
  //
  // Render
  //
  render: function() {
    return el.div(
      null,
      el.div(
        {className: 'row'},
        el.div(
          {className: 'col-md-9'},
          el.div(
            {className: 'panel panel-default'},
            // panel-body
            el.div(
              {className: 'panel-body'},
              el.ul(
                {
                  ref: 'chatListRef',
                  className: 'list-unstyled messages',
                  style: {
                    resize: 'vertical',
                    overflowY: 'scroll',
                    height: '300px',
                    wordWrap: 'break-word'
                  }
                },
                this.state.messages.map(function(m) {
                  var class1 = m.mentions_user ? ' mentions-user ' : '';
                  return el.li(
                    {
                      key: m.id,
                      tabIndex: 1,
                      className: 'message-item ' + class1
                    },
                    el.code(
                      null,
                      helpers.formatMessageDate(m.created_at)
                    ),
                    ' ',
                    this._renderMessage(m)
                  );
                }, this)
              )
            ),
            // panel-footer
            el.div(
              {className: 'panel-footer'},
              el.div(
                null,
                el.div(
                  {className: 'row'},
                  el.div(
                    {className: 'col-md-9'},
                    el.input(
                      {
                        type: 'text',
                        placeholder: 'Click here and begin typing...',
                        className: 'form-control message-input',
                        ref: 'input',
                        value: this.state.text,
                        onChange: this._onInputChange,
                        onKeyDown: this._onInputKeyDown,
                        readOnly: this.state.waitingOnServer
                      }
                    )
                  ),
                  el.div(
                    {className: 'col-md-3'},
                    el.button(
                      {
                        type: 'button',
                        className: 'btn btn-default btn-block',
                        onClick: this._submitMessage,
                        disabled: !helpers.isTextValid(this.state.text) || !this.state.user || this.state.waitingOnServer
                      },
                      this.state.user ?
                        (this.state.waitingOnServer ? 'Submitting...' : 'Send') :
                        'Login to chat'
                    )
                  )
                ),
                // Row 2 of footer
                el.div(
                  {
                    className: 'row',
                    style: {
                      marginTop: '10px'
                    }
                  },
                  el.div(
                    {className: 'col-md-6'},
                    el.div(
                      {
                        className: 'text-counter' +
                          this.state.text && this.state.text.length > 300 ?
                          ' text-counter-error ' : ''
                      },
                      this.state.text.length + '/300'
                    )
                  ),
                  // Sound option
                  el.div(
                    {className: 'col-md-6 text-right'},
                      el.button(
                        {
                          type: 'button',
                          className: 'btn btn-default btn-xs sound-btn',
                          onClick: this._onSoundClick
                        },
                        'Sound ',
                        this.state.soundEnabled ?
                          el.span(
                            {
                              className: 'label label-success',
                              style: { color: '#fff' }
                            },
                            'ON'
                          ) :
                          el.span(
                            {
                              className: 'label label-default',
                              style: { color: '#fff' }
                            },
                            'OFF'
                          )
                      )
                  )
                )
              )
            )

          ),
          // Smilie bar
          React.createElement(SmilieList, {
            _makeSmilieClickHandler: this._makeSmilieClickHandler
          })
        ),
        el.div(
          // UserList
          {className: 'col-md-3'},
          React.createElement(UserList, {
            userList: this.state.userList,
            receivedServerPayload: this.state.receivedServerPayload,
            onUnameClick: this._onUnameClick
          }),
          // MuteList
          React.createElement(MuteList, {
            muteList: this.state.muteList,
            receivedServerPayload: this.state.receivedServerPayload
          })
        )
      )
    );
  }
});

React.render(
  React.createElement(App),
  document.getElementById('app')
);
