"use strict";
// Node
var util = require('util');
// 3rd
var assert = require('better-assert');
var _ = require('lodash');
var debug = require('debug')('app:search');
// 1st
var db = require('./db');
var config = require('./config');

var AWS = require('aws-sdk');
AWS.config.region = 'us-east-1';

var client = new AWS.CloudSearchDomain({
  apiVersion: '2013-01-01',
  endpoint: config.AWS_CLOUDSEARCH_DOCUMENT_ENDPOINT
});

// Tree can be
// ['or' [ ... ]] -> (or ...)
// ['or' ['user_id', 42]] -> (or user_id:42)
// ['user_id', 42] -> user_id:42
// ['user_id', '42'] -> user_id:'42'
//
// tree is always a vector
var treeToQueryString = function(tree) {
  if (_.isEmpty(tree))
    return '';

  if (['and', 'or', 'term'].includes(tree[0]))
    if (_.tail(tree).length <= 1)
      return  _.tail(tree).map(treeToQueryString).join(' ');
    else
      return '(' + tree[0] + ' ' + _.tail(tree).map(treeToQueryString).join(' ') + ')';
  else if (_.isString(tree))
    return '\'' + tree + '\'';
  else
    return  tree[0] + ':' + (_.isString(tree[1]) ? '\'' + tree[1] + '\'' : tree[1]);
};

var buildSearchTree = function(props) {
  debug('[buildSearchTree] props:', props);

  var q = ['and'];

  // if (props.term)
  //   q.push(['term', ['field', 'markup'], props.term]);

  if (!_.isEmpty(props.user_ids)) {
    var expr = ['or'];
    props.user_ids.forEach(function(id) { expr.push(['user_id', id]); });
    q.push(expr);
  }

  // post_types :: Array
  if (!_.isEmpty(props.post_types)) {
    q.push(['or'].concat(props.post_types.map(function(type) {
      return ['post_type', type];
    })));
  }

  if (props.topic_id) {
    q.push(['topic_id', props.topic_id]);
  }

  if (!_.isEmpty(props.forum_ids)) {
    q.push(['or'].concat(props.forum_ids.map(function(id) {
      return ['forum_id', id];
    })));
  }
  return q;
};

////////////////////////////////////////////////////////////

// Takes the same args as searchPosts, but returns the params sent to
// CloudSearch. useful for debugging.
exports.buildSearchParams = function(props) {
  var params = {
    // Just return document id
    return: '_no_fields',
    size: config.SEARCH_RESULTS_PER_PAGE
  };

  if (props.sort)
    switch(props.sort) {
      case 'newest-first':
        params.sort = 'created_at desc';
        break;
      case 'oldest-first':
        params.sort = 'created_at asc';
        break;
      case 'relevance':
        params.sort = '_score desc, created_at desc';
        break;
      default:
        throw new Error(util.format('Unexpected props.sort: %j', params.sort));
    }
  else
    params.sort = 'created_at desc';

  // params.query = query;

  if (props.term) {
    params.queryParser = 'simple';
    params.query = props.term;
    params.highlight = JSON.stringify({
      markup: {
        format: 'html',
        max_phrases: 3, // default: 1
        pre_tag: '<strong>',
        post_tag: '</strong>'
      }
    });
  } else {
    params.queryParser = 'structured';
    params.query = 'matchall';
  }

  var tree = buildSearchTree(props);
  debug('tree:', tree);
  var filterQuery = treeToQueryString(tree);
  debug('filterQuery:', filterQuery);
  // var encodedQuery = encodeURIComponent(query).replace(/%20/g, '+');
  // debug('encodedQuery:', encodedQuery);

  if (filterQuery)
    params.filterQuery = filterQuery;

  debug('params:', params);

  return params;
};

////////////////////////////////////////////////////////////

exports.searchPosts = function(props) {
  var params = exports.buildSearchParams(props);

  return new Promise(function(resolve, reject) {
    client.search(params, function(err, data) {
      if (err) return reject(err);
      return resolve(data);
    });
  });
};
