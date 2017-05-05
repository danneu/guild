// Node
// 3rd party
var _ = require('lodash');
var debug = require('debug')('task:batch_upload_posts');
var assert = require('better-assert');
var AWS = require('aws-sdk');
// 1st party
var config = require('../server/config');
const {pool} = require('../server/db/util')
const {sql} = require('pg-extra')

assert(config.NODE_ENV === 'production');
assert(config.IS_CLOUDSEARCH_CONFIGURED);

AWS.config.region = 'us-east-1';

const client = new AWS.CloudSearchDomain({
  apiVersion: '2013-01-01',
  endpoint: config.AWS_CLOUDSEARCH_DOCUMENT_ENDPOINT
})

////////////////////////////////////////////////////////////

// Can only allow markup chars that are valid in xml 1.0
// according to CloudSearch docs.
const replaceInvalidChars = function (str) {
  return str.replace(/\u00B7/g,'')
    .replace(/\u00C2/g,'')
    .replace(/\u00A0/g,'')
    .replace(/\u00A2/g,'')
    .replace(/\u00A3/g,'')
    .replace(/[^\u000D\u00B7\u0020-\u007E\u00A2-\u00A4]/g,'')
    .trim();
};

// Post -> BodyItem
var postToBodyItem = function(post) {
  // Required fields
  var fields = {
    markup:     replaceInvalidChars(post.markup),
    created_at: post.created_at,
    forum_id:   post.forum.id,
    topic_id:   post.topic_id,
    user_id:    post.user_id,
    post_type:  post.type
  };

  // Return null if markup is empty, particularly after replacing invalid chars
  _.toPairs(fields).map(function(pair) {
    var k = pair[0], v = pair[1];
    if (!v) {
      console.log('Problem with post', post.id, 'markup.');
      console.log(k, v);
    }
  });

  // Ensure all required fields are set to truthy values
  if (!_.all(_.values(fields)))
    return;

  // Set nullable fields
  if (!_.isEmpty(post.tag_ids))
    fields.tag_ids = post.tag_ids;

  return {
    type:   'add',
    id:     post.id,
    fields: fields
  };
};

// [Posts] -> AmazonResponse
function batchUploadPosts (posts) {
  return new Promise(function(resolve, reject) {
    var params = {
      contentType: 'application/json',
      documents: JSON.stringify(_.compact(posts.map(postToBodyItem)))
    }
    client.uploadDocuments(params, (err, data) => {
      if (err) return reject(err);
      return resolve(data);
    })
  });
}

var queries = {
  findPostsToUpload: async () => {
    return pool.many(sql`
      SELECT
        *
      FROM (
        SELECT
          p.*,
          to_json(f.*) "forum",
          (
          SELECT array_agg(id)
          FROM tags
          JOIN tags_topics ON tags.id = tags_topics.tag_id
          WHERE tags_topics.topic_id = t.id
          ) tag_ids,

          sum(char_length(p.markup)) over (order by p.id asc) as char_total
        FROM posts p
        JOIN topics t ON p.topic_id = t.id
        JOIN forums f ON t.forum_id = f.id
        WHERE
          p.markup IS NOT NULL
          AND (
            -- Has not yet been uploaded
            p.uploaded_at IS NULL
            -- Has been edited since last upload
            OR p.updated_at > p.uploaded_at
          )
        GROUP BY p.id, f.id, t.id
        ORDER BY p.id
      ) pp
      WHERE char_total <= 4500000  -- 4.5 MB
    `)
  },
  massUpdatePostUploadedAt: async (post_ids) => {
    assert(_.isArray(post_ids));
    return pool.query(sql`
      UPDATE posts
      SET uploaded_at = now()
      WHERE id = ANY (${post_ids}::int[])
    `)
  }
};

(async () => {
  const posts = await queries.findPostsToUpload()

  // Noop if no posts found
  if (_.isEmpty(posts)) {
    console.log('No posts to upload');
    return;
  }

  // Posts found, so let's upload them
  console.log('Batch uploading', posts.length, 'posts to CloudSearch...');

  const response = await batchUploadPosts(posts)
  console.log('Response came back');
  if (response.status === 'success') { //&& response.adds === posts.length) {
    // Update the uploaded_at of the uploaded posts
    await queries.massUpdatePostUploadedAt(posts.map((x) => x.id));
    console.log('Success');
  }
})().then(
  function() {
    console.log('OK');
    process.exit(0);
  },
  function(ex) {
    console.log('Error:', ex, ex.stack);
    process.exit(1);
  }
)

/* co(function*() {
 *   var posts = yield queries.findPostsToUpload();
 *
 *   // Noop if no posts found
 *   if (_.isEmpty(posts)) {
 *     console.log('No posts to upload');
 *     return;
 *   }
 *
 *   // Posts found, so let's upload them
 *   console.log('Batch uploading', posts.length, 'posts to CloudSearch...');
 *
 *   var response = yield batchUploadPosts(posts);
 *   console.log('Response came back');
 *   if (response.status === 'success') { //&& response.adds === posts.length) {
 *     // Update the uploaded_at of the uploaded posts
 *     yield queries.massUpdatePostUploadedAt(_.pluck(posts, 'id'));
 *     console.log('Success');
 *   }
 * })
 *   .then(
 *   function() {
 *     console.log('OK');
 *     process.exit(0);
 *   },
 *   function(ex) {
 *     console.log('Error:', ex, ex.stack);
 *     process.exit(1);
 *   }
 * );*/
