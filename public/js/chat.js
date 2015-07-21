'use strict';

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
  componentDidUpdate: function() {
    $("abbr.timeago").timeago();
  },
  render: function() {
    return el.div(
      null,
      'Mute list: ' + _.keys(this.props.muteList).length,
      el.ul(
        null,
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
          null,
          _.values(this.props.userList).map(function(u) {
            return el.li(
              null,
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
                  //href: '/users/' + u.slug,
                  href: '#',
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
      m.html = helpers.safeAutolink(m.text);
    }

    return m;
  };
};

var App = React.createClass({
  getInitialState: function() {
    return {
      text: '',
      user: undefined,
      messages: new CBuffer(100),
      // String or undefined
      session_id: $('#session-id').attr('data-session-id'),
      socket: undefined,
      userList: {},
      muteList: {},
      receivedServerPayload: false
    };
  },
  componentWillMount: function() {
    var chat_server_url = $('#chat-server-url').attr('data-chat-server-url');
    this.setState({ socket: io(chat_server_url) });
  },
  componentDidMount: function() {
    var self = this;
    this.state.socket.on('reconnect', function() { console.log('Reconnect'); });
    this.state.socket.on('disconnect', function() { console.log('Disconnect'); });
    this.state.socket.on('user_unmuted', function(uname) {
      delete self.state.muteList[uname];
      self.setState({});
    });
    this.state.socket.on('user_muted', function(uname, expires_at) {
      if (expires_at) {
        expires_at = new Date(expires_at);
      }
      self.state.muteList[uname] = expires_at;
      self.setState({});
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

        // HACK: Mutating state outside of setState
        var messages = new CBuffer(100);
        data.messages = data.messages.map(helpers.makeMessagePresenter(data.user && data.user.uname));

        messages.push.apply(messages, data.messages);
        //self.state.messages.push.apply(self.state.messages, data.messages);

        self.setState({
          user: data.user,
          messages: messages,
          userList: userList,
          muteList: data.muteList,
          receivedServerPayload: true
        }, self._scrollChat);
      });

      ////////////////////////////////////////////////////////////

      self.state.socket.off('new_message').on('new_message', function(message) {
        message = helpers.makeMessagePresenter(self.state.user.uname)(message);

        // Hack
        self.state.messages.push(message);
        self.setState({
          //messages: self.state.messages.concat([message])
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
    this.state.socket.emit('new_message', this.state.text, function(errString) {
      if (errString) {
        alert('Error: ' + errString);
        return;
      }
      self.setState({ text:  '' }, function() {
        self.refs.input.getDOMNode().focus();
      });
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
      console.log('DistanceFromBottom:', distanceFromBottom);
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
    return false;
  },
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
                this.state.messages.toArray().map(function(m) {
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
                    m.system ?
                      el.code({clasName: 'message-text'}, m.text) :
                      el.a(
                        {
                          href: '#',
                          onClick: this._onUnameClick
                        },
                        el.code(
                          {
                            className: 'message-uname',
                            style: {
                              // Lightened. Up = lighter
                              color: helpers.shadeBlend(0.30, helpers.toMD5HexColor(m.user.uname), '#ffffff')
                              // color: helpers.lightencolor(helpers.tomd5hexcolor(m.user.uname), 25)
                              // color: helpers.lightenColor(helpers.toMD5HexColor(m.user.uname), -25)
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
                    m.system ?
                      '' :
                      el.span(
                        {
                          className: 'message-text',
                          dangerouslySetInnerHTML: {
                            __html: ' ' + m.html
                          }
                        }
                      )
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
                        onKeyDown: this._onInputKeyDown
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
                        disabled: !helpers.isTextValid(this.state.text) || !this.state.user
                      },
                      this.state.user ? 'Send' : 'Login to chat'
                    )
                  )
                ),
                // Row 2 of footer
                el.div(
                  {className: 'row'},
                  el.div(
                    {className: 'col-md-12'},
                    el.div(
                      {
                        className: 'text-counter' +
                          this.state.text && this.state.text.length > 300 ?
                          ' text-counter-error ' : ''
                      },
                      this.state.text.length + '/300'
                    )
                  )
                )
              )
            )

          )
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
