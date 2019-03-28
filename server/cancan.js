'use strict'
// Node
var util = require('util')
// 3rd party
var _ = require('lodash')
var debug = require('debug')('app:cancan')
var assert = require('better-assert')
// 1st
const belt = require('./belt')
const config = require('./config')

// These are forums where topics cannot be posted
// in if the latest post is older than 1 month
const ANTI_NECRO_FORUMS = [
    30, // Spam
    32, // Member Lounge
    33, // Off-topic
    9, // Bugs/feature requests
    36, // Need help?
    1, // News
    2, // Introduce yourself
]

const CONTEST_FORUMS = [45, 44]
const ARENA_FORUMS = [6, 15]
// Forums that pwmods have mod-privs in
const PW_FORUMS = [
    49,
    50,
    51,
]

// Applies to anyone above member
//
// TODO: Now that I've added the 'conmod' role, this function doesn't make
// much sense since many times I use this function (like to restrict LexusLounge
// access) I don't want to include conmods. But I would still consider them staff.
// I think I should replace this function with explicitly inlining the
// [x, y, z].includes(role) call and removing this function.
exports.isStaffRole = isStaffRole
function isStaffRole(role) {
    return ['mod', 'smod', 'admin'].includes(role)
}

exports.isTopicGm = (user, topic) => {
    assert(topic)
    assert(Array.isArray(topic.co_gm_ids))
    if (!user) return false
    if (user.id === topic.user_id) return true
    if (topic.co_gm_ids.some(id => id === user.id)) return true
    return false
}

// TODO: Actually write tests for these
// TODO: Implement rules for all rules, not just member and admin
exports.can = function(user, action, target) {
    var result = can(user, action, target)
    debug(
        '[cancan] %s %s %s %s %s: %s',
        (user && util.format('%s [%d]', user.uname, user.id)) || '<Guest>',
        // can/cannot
        (result ? '\u001b[1;32m can' : '\u001b[1;31m cannot') + ' \u001b[0m',
        action,
        target && util.format('[%s]', target.id),
        ((target && JSON.stringify(target)) || 'undefined').slice(0, 50)
    )
    return result
}
function can(user, action, target) {
    switch (action) {
        case 'ACCESS_TOPIC_MODKIT': // target is topic
            if (!user) return false
            if (['mod', 'smod', 'admin'].includes(user.role)) return true
            if (
                user.role === 'conmod' &&
                CONTEST_FORUMS.includes(target.forum_id)
            ) {
                return true
            }
            if (
                user.role === 'arenamod' &&
                ARENA_FORUMS.includes(target.forum_id)
            ) {
                return true
            }
            if (
                user.role === 'pwmod' &&
                PW_FORUMS.includes(target.forum_id)
            ) {
                return true
            }
            // Can if they are forum mod
            if ((target.mods || []).some(m => m.id === user.id)) {
                return true
            }
            return false
        case 'MANAGE_TROPHY_SYSTEM': // no target, intended to wrap all privs
        case 'UPDATE_TROPHY': // target is trophy
        case 'CREATE_TROPHY_GROUP': // no target
        case 'UPDATE_TROPHY_GROUP': // target is trophy-group
            // Guests can't
            if (!user) return false
            // Conmods can
            if (user.role === 'conmod') return true
            // Admin can
            if (user.role === 'admin') return true
            return false
        case 'DELETE_NOTIFICATION': // target is notification
            // Guests can't
            if (!user) return false
            // Banned can't
            if (user.role === 'banned') return false
            // User can if it's their notification
            if (user.id === target.to_user_id) return true
            return false
        // TODO: Replace this with MANAGE_USER_STATUS
        case 'DELETE_USER_STATUS': // target is status
            // Guests can't
            if (!user) return false
            // Banned can't
            if (user.role === 'banned') return false
            // User can delete their own statuses
            if (user.id === target.user_id) return true
            // Staff can
            if (isStaffRole(user.role)) return true
            return false
        case 'MANAGE_USER_STATUS': // target is user
            // Guests can't
            if (!user) return false
            // Banned can't
            if (user.role === 'banned') return false
            // User can delete their own statuses
            if (user.id === target.id) return true
            // Staff can
            if (isStaffRole(user.role)) return true
            return false
        case 'LIKE_STATUS': // target status
            // Guests can't
            if (!user) return false
            // Banned can't
            if (user.role === 'banned') return false
            // Users can't like if its their own status
            if (user.id === target.user_id) return false
            // Users can like it if they haven't already liked it
            if (!target.liked_user_ids.includes(user.id)) return true
            return false
        case 'CREATE_USER_STATUS': // target is user
            // Guests can't
            if (!user) return false
            // Banned can't
            if (user.role === 'banned') return false
            // User can update themself
            if (user.id === target.id) return true
            return false
        // Expresses user's ability to update any part of a topic
        // Only use this for high level checks like to see if a user
        // should see the "Edit Topic" link at all. The actual actions they
        // can do to a topic will vary.
        // Use the specific checks for granular authorization.
        case 'UPDATE_TOPIC': // target is topic
            // Guests can't
            if (!user) return false
            // Banned can't
            if (user.role === 'banned') return false
            // Staff can
            if (isStaffRole(user.role)) return true
            // Conmod can if it's in contest forums
            if (
                user.role === 'conmod' &&
                CONTEST_FORUMS.includes(target.forum_id)
            )
                return true
            // Arena Mod can // TODO: if it's in ArenaRP forum
            if (
                ARENA_FORUMS.includes(target.forum_id) &&
                user.role === 'arenamod'
            )
                return true
            if (
                PW_FORUMS.includes(target.forum_id) &&
                user.role === 'pwmod'
            )
                return true
            // If non-staff, then cannot if topic is hidden/closed
            if (target.is_closed || target.is_hidden) return false
            // GMs can
            if (exports.isTopicGm(user, target)) {
                return true
            }
            // FIXME: (Sloppy) Check if user is eligible for any of the types of edits
            return (
                can(user, 'UPDATE_TOPIC_JOIN_STATUS', target) ||
                can(user, 'UPDATE_TOPIC_TAGS', target) ||
                can(user, 'UPDATE_TOPIC_CO_GMS', target)
            )
        case 'UPDATE_TOPIC_JOIN_STATUS': // target is topic
            // Nobody can unless it's a roleplay
            if (!target.is_roleplay) return false
            // Guests cant
            if (!user) return false
            // Topic creator can
            if (user.id === target.user_id) return true
            // co-GMs can
            if (target.co_gm_ids.includes(user.id)) return true
            // Staff can
            if (isStaffRole(user.role)) return true
            return false
        case 'UPDATE_TOPIC_TAGS': // target is topic
            assert(target.forum)
            // Nobody can unless forum has tags enabled
            if (!target.forum.has_tags_enabled) return false
            // Guests never can
            if (!user) return false
            // GM can
            if (target.user_id === user.id) return true
            // Co-GMs can
            if (target.co_gm_ids.includes(user.id)) return true
            // Staff can
            if (isStaffRole(user.role)) return true
            return false
        case 'UPDATE_TOPIC_CO_GMS': // target is topic
            // Only roleplays can have co-GMs
            if (!target.is_roleplay) return false
            // Guests can't
            if (!user) return false
            // GM can
            if (target.user_id === user.id) return true
            // Staff can
            if (isStaffRole(user.role)) return true
            return false
        case 'UPDATE_USER_CUSTOM_TITLE': // target is user
            // Guests cannot
            if (!user) return false
            // Members and Conmods can only change their own
            if (['member', 'conmod'].includes(user.role))
                return user.id === target.id
            // Mods can change their own title and the title of any non-staff
            if (user.role === 'mod')
                return user.id === target.id || !isStaffRole(target.role)
            // Smods can change mods and below
            if (user.role === 'smod')
                return (
                    user.id === target.id ||
                    target.role === 'mod' ||
                    !isStaffRole(target.role)
                )
            // Admins can change all
            if (user.role === 'admin') return true
            return false
        // The ratings table is on the user profile
        case 'READ_USER_RATINGS_TABLE': // target is user
            // Guests cannot
            if (!user) return false
            // Banned cannot
            if (user.role === 'banned') return false
            // Staff can read everyone's
            if (isStaffRole(user.role)) return true
            // everyone can read their own
            return user.id === target.id
        case 'RATE_POST': // target is post
            // Guests can't rate
            if (!user) return false
            // Banned members can't rate
            if (user.role === 'banned') return false
            // Cannot rate your own post
            if (user.id === target.user_id) return false
            // Can rate if you're authorized to read post
            return can(user, 'READ_POST', target)
        case 'READ_USER_LIST': // no target
            // Let guests read this for now
            return true
        //
        // Only registered users can
        // if (!user) return false;
        // return true;
        case 'UPDATE_TOPIC_TITLE': // target is topic
            if (!user) return false
            // Banned users can't update their old topics
            if (user.role === 'banned') return false
            // Staff can edit all topic titles
            if (isStaffRole(user.role)) return true
            // Topic owner/GM can edit their own titles
            if (user.id === target.user_id) return true
            // Co-GMs can also edit topic title
            if (target.co_gm_ids.includes(user.id)) return true
            // Conmods can edit any topic in contest forums
            if (
                user.role === 'conmod' &&
                CONTEST_FORUMS.includes(target.forum_id)
            )
                return true
            // Arena mods can edit topic titles in arena forum
            if (
                user.role === 'arenamod' &&
                ARENA_FORUMS.includes(target.forum_id)
            )
                return true
            if (
                user.role === 'pwmod' &&
                PW_FORUMS.includes(target.forum_id)
            )
                return true
            return false
        case 'UPDATE_TOPIC_ARENA_OUTCOMES': // target is topic
            // Guests can't
            if (!user) {
                return false
            }
            // Staff can
            if (isStaffRole(user.role)) {
                return true
            }
            // Arena mods can if topic is in arena forum
            if (target.forum.is_arena_rp && user.role === 'arenamod') {
                return true
            }
            return false
        case 'READ_USER_ONLINE_STATUS': // target is user
            // Guests and members can see status if target isn't in invisible mode.
            if (!user) return !target.is_ghost
            // Members & conmods can see themselves regardless of ghost status
            if (['member', 'conmod'].includes(user.role))
                return target.id === user.id || !target.is_ghost
            // Staff can see ghosts
            if (isStaffRole(user.role)) return true
            return false
        case 'DELETE_USER': // target is user
            if (!user) return false
            return user.role === 'admin'
        case 'READ_USER_PM_SENT_COUNT': // target is user
            // Guests cannot
            if (!user) return false
            // Only staff can read user pm-sent count
            if (isStaffRole(user.role)) return true
            return false
        case 'UPDATE_USER_ROLE': // target is user
            if (!user) return false
            if (user.role === 'admin') return true
            // smods can change everyone except admin
            if (user.role === 'smod') return target.role !== 'admin'
            // mods can change non-staff and pw-mods
            if (user.role === 'mod')
                return ['banned', 'member', 'pwmod'].includes(target.role)
            return false
        case 'UPDATE_USER': // target is user
            if (!user) return false
            if (user.role === 'banned') return false
            // Anyone can update themselves
            if (user.id === target.id) return true
            // Staff can change staff below them
            if (user.role === 'admin') return true
            if (user.role === 'smod') return target.role !== 'admin'
            if (user.role === 'mod')
                return ['banned', 'member', 'pwmod'].includes(target.role)
            return false
        // Post state -- target is post
        case 'UNHIDE_POST':
            if (!user) return false
            // Staff can unhide
            if (isStaffRole(user.role)) return true
            if (user.role === 'conmod') return true
            if (user.role === 'arenamod') return true
            // GMs can unhide zeroth post
            if (target.idx === -1 && exports.isTopicGm(user, target.topic)) {
                return true
            }
            return false
        case 'HIDE_POST':
            if (!user) return false
            assert(target.topic)
            // Cannot hide a post if it is the last post in this topic/RP
            //if (target.topic && target.topic.posts_count === 1) {
            //  return false
            //}
            // Staff can hide
            if (isStaffRole(user.role)) return true
            // TODO: Only let boutique mods hide posts in their respective forums.
            if (user.role === 'conmod') return true
            if (user.role === 'arenamod') return true
            if (user.role === 'pwmod') return true
            // GMs can hide zeroth post
            if (target.idx === -1 && exports.isTopicGm(user, target.topic)) {
                return true
            }
            // Users can hide their own post if the post within 1 hour
            // Caution: remember to handle the case where this is the last unhidden
            // post in a topic.
            // TEMP: Turned this off while I figure out some issues
            /* if (user.id === target.user_id && belt.isNewerThan(target.created_at, { hours: 1 })) {
       *   return true
       * }*/
            return false
        // Topic state
        case 'MOVE_TOPIC':
            if (!user) return false
            if (isStaffRole(user.role)) return true
            return false
        case 'STICK_TOPIC':
        case 'UNSTICK_TOPIC':
        case 'HIDE_TOPIC':
        case 'UNHIDE_TOPIC':
        case 'CLOSE_TOPIC':
        case 'OPEN_TOPIC':
            // Guests cannot
            if (!user) return false
            // Staff can do this
            if (isStaffRole(user.role)) return true
            // Conmods can manage topics in contest forums
            if (
                user.role === 'conmod' &&
                CONTEST_FORUMS.includes(target.forum_id)
            )
                return true
            // Arena mod can in arena forums
            if (
                user.role === 'arenamod' &&
                ARENA_FORUMS.includes(target.forum_id)
            )
                return true
            if (
                user.role === 'pwmod' &&
                PW_FORUMS.includes(target.forum_id)
            )
                return true
            // Can if they are forum mod
            if ((target.mods || []).some(m => m.id === user.id)) {
                return true
            }
            return false
        case 'CREATE_POST': // target is topic
            if (!user) return false
            if (user.role === 'banned') return false
            // Staff can always create posts anywhere
            if (isStaffRole(user.role)) return true
            // Can if they are forum mod
            if ((target.mods || []).some(m => m.id === user.id)) {
                return true
            }
            // TODO: Limit boutique mods to respective forums.
            if (user.role === 'conmod') {
                return true
            }
            if (user.role === 'arenamod') {
                return true
            }
            if (user.role === 'pwmod') {
                return true
            }
            // Members can post as long as it's outside the lexus lounge,
            // the topic is open, and the topic is visible
            // and they are not on topic's banlist
            if (user.role === 'member') {
                if (target.category_id === 4) return false
                if (target.is_closed) return false
                if (target.is_hidden) return false
                if ((target.banned_ids || []).includes(user.id)) return false

                // Topic latest_post_at must be newer than 1 month
                // if in certain forums where necro'ing is disruptive
                if (ANTI_NECRO_FORUMS.includes(target.forum_id)) {
                    debug(ANTI_NECRO_FORUMS.includes(target.forum_id))
                    var t = new Date()
                    t.setMonth(t.getMonth() - 1)
                    return target.latest_post_at > t
                }
                return true
            }
            return false
        case 'READ_PM': // target is pm with pm.convo and pm.participants props
            // Guests can't
            if (!user) return false
            // Admin can see all
            if (user.role === 'admin') return true
            return target.participants.some(p => p.id === user.id)
        case 'READ_POST': // target is post with a post.topic prop
            assert(target, 'Post missing')
            assert(target.topic, 'post.topic is missing')
            assert(target.forum, 'post.forum is missing')
            // Staff can read all posts
            if (user && isStaffRole(user.role)) return true
            if (target.forum.category_id === 4) {
                return can(user, 'LEXUS_LOUNGE')
            }
            // conmods can read all posts in contest forums
            if (
                user &&
                user.role === 'conmod' &&
                CONTEST_FORUMS.includes(target.topic.forum_id)
            ) {
                return true
            }
            // arnamods can read all posts in arena forums
            if (
                user &&
                user.role === 'arenamod' &&
                ARENA_FORUMS.includes(target.topic.forum_id)
            ) {
                return true
            }
            // pwmods can read all posts in pw forums
            if (
                user &&
                user.role === 'pwmod' &&
                PW_FORUMS.includes(target.topic.forum_id)
            ) {
                return true
            }
            // GMs can always read the zeroth post even if hidden
            if (exports.isTopicGm(user, target.topic)) {
                return true
            }

            // Everyone else can read a post as long as it's not hidden,
            // the topic is not hidden, and the topic is not in lexus lounge
            return (
                !target.is_hidden &&
                !target.topic.is_hidden &&
                target.forum.category_id !== 4
            )
        case 'READ_USER_IP': // target is a user
            if (!user) return false
            // Staff can only see down-chain
            if (user.role === 'admin') return true
            if (user.role === 'smod')
                return ['mod', 'member', 'banned'].includes(target.role)
            if (user.role === 'mod')
                return ['member', 'banned'].includes(target.role)
            return false
        case 'READ_FORUM': // target is a forum
            // TODO: Remove hardcoded mod forum
            if (target.category_id === 4)
                return (
                    user &&
                    (isStaffRole(user.role) ||
                        ['conmod', 'arenamod'].includes(user.role))
                )
            else return true // for now, anyone can read a non-lexus-lounge forum
            // TODO: Forum mods should be able to read their own forum,
            // maybe it canbe hidden from others? Unlisted while they work?
            return false
        case 'LEXUS_LOUNGE': // no target
            if (!user) return false
            // All staff can access
            if (isStaffRole(user.role)) return true
            // conmods and arenamods can (pwmod can't. TODO: remove conmods and arenamods too)
            if (['conmod', 'arenamod'].includes(user.role)) return true
            return false
        // TODO: Replace LEXUS_LOUNGE with this?
        case 'READ_CATEGORY': //  target is category
            // Users can view any category except for lexus lounge
            // Only staff can view lexus lounge
            if (target.id === 4)
                return ['conmod', 'arenamod', 'mod', 'smod', 'admin'].includes(
                    user.role
                )
            else return true
            return false
        case 'UNSUBSCRIBE_TOPIC':
            // A user can unsubscribe from a topic if they're logged in
            return !!user
        case 'SUBSCRIBE_TOPIC': // target is topic
            if (!user) return false
            // banned cannot
            if (user.role === 'banned') return false
            // everyone else can if they can read the topic
            return can(user, 'READ_TOPIC', target)
        case 'CREATE_PM': // target is convo w/ participants prop
            if (!user) return false
            if (user.role === 'banned') return false
            // User can send pm if they're a participant
            return !!_.find(target.participants, { id: user.id })
        case 'READ_TOPIC': // target is topic
            assert(target.forum)
            // Only staff can read lexus lounge
            if (target.forum.category_id === 4)
                return (
                    user &&
                    (isStaffRole(user.role) ||
                        ['conmod', 'arenamod'].includes(user.role))
                )
            // conmod can read any topic in contests forum
            if (
                user &&
                user.role === 'conmod' &&
                CONTEST_FORUMS.includes(target.forum_id)
            )
                return true
            // arenamod can read any topic in arena forums
            if (
                user &&
                user.role === 'arenamod' &&
                ARENA_FORUMS.includes(target.forum_id)
            )
                return true
            // pwmod can read any topic in pw forums
            if (
                user &&
                user.role === 'pwmod' &&
                PW_FORUMS.includes(target.forum_id)
            )
                return true
            // Staff can always read hidden topics
            if (user && target.is_hidden && isStaffRole(user.role)) {
                return
            }
            // forum mods can read all tpics in their appointed forum
            if (user && (target.mods || []).some(m => m.id === user.id)) {
                return true
            }
            if (!target.is_hidden) {
                return true
            }
            return false
        case 'CREATE_CONVO': // no target
            if (!user) return false
            // Any user that isn't banned can start convo
            return user.role !== 'banned'
        case 'CREATE_TOPIC': // target is forum
            assert(target)
            if (!user) return false
            if (user.role === 'banned') return false
            // Members can create topics in any category that's not Lexus Lounge
            if (user.role === 'member') return target.category_id !== 4
            // Only staff can create topics in lexus lounge
            if (target.id === 4)
                return (
                    isStaffRole(user.role) ||
                    ['conmod', 'arenamod'].includes(user.role)
                )
            if (
                ['mod', 'arenamod', 'conmod', 'pwmod', 'smod', 'admin'].includes(
                    user.role
                )
            )
                return true
            if (user.role === 'member') return true
            return false
        case 'UPDATE_PM': // target is pm with pm.convo and pm.participants
            if (!user) return false
            if (user.role === 'banned') return false
            // Can't update legacy PMs. TODO: Implement BBCode editing for PMs
            // once post BBCode system is tested
            if (target.legacy_html) return false
            // User can update a PM if they own it
            if (target.user_id === user.id) return true
            return false
        case 'UPDATE_POST': // target expected to be a post
            // target should have target.topic
            // FIXME: target must have { banned_ids: null | [Int] } to prevent users
            // from sabotaging posts after getting banned from a topic.
            if (!user) return false
            if (user.role === 'banned') return false
            // Admin can update any post
            if (user.role === 'admin') return true
            // GM and Co-GM can edit the 0th post
            if (target.idx === -1 && exports.isTopicGm(user, target.topic)) {
                return true
            }
            // Cannot update post if banned from topic
            if ((target.banned_ids || []).includes(user.id)) return false
            // TODO: Create rules for other staff roles
            // User can edit their own post
            if (user.id === target.user_id) return true
            // All Staff can edit a post if it's the FAQ_POST_ID
            if (target.id === config.FAQ_POST_ID && isStaffRole(user.role)) {
                return true
            }
            // All Staff can edit a post if it's the WELCOME_POST_ID
            if (
                target.id === config.WELCOME_POST_ID &&
                isStaffRole(user.role)
            ) {
                return true
            }
            // All staff can edit any post unless it's admin's post
            //if (isStaffRole(user.role) && target.user_id !== 1) {
            //  return true
            //}
            return false
        case 'DELETE_CONVO': // target is convo
        case 'READ_CONVO': // target is convo
            // Banned members can't
            if (!user) return false
            // Admin can read all convos
            if (user.role === 'admin') return true
            // Users can only read convos they're participants of
            if (target.participants.some(x => x.id === user.id)) return true
            return false
        case 'DELETE_VM': // target is vm
            if (!user) return false
            if (user.role === 'banned') return false
            // You can delete your own VM
            if (user.id === target.from_user_id) return true
            // You can delete VMs on your wall unless it's from staff
            if (user.id === target.to_user_id && user.role === 'member')
                return !isStaffRole(target.from_user.role)
            // Staff
            if (user.role === 'admin') {
                return true
            }
            if (user.role === 'smod') {
                return target.from_user.role !== 'admin'
            }
            if (user.role === 'mod') {
                return !isStaffRole(target.from_user.role)
            }
            return false
        case 'CREATE_VM': // no target
            // Guests can't
            if (!user) return false
            // Banned can't
            if (user.role === 'banned') return false
            // Everyone else can
            return true
        case 'NUKE_USER': // target is spambot user
            // guests cannot
            if (!user) return false
            // staff can ban non-staff
            if (isStaffRole(user.role) && !isStaffRole(target.role)) return true
            return false
        case 'MANAGE_IMAGES': // target is the user being managed
            if (!user) return false
            if (user.role === 'banned') return false
            if (user.id === target.id) return true
            if (isStaffRole(user.role) && !isStaffRole(target.role)) return true
            return false
        case 'UPLOAD_IMAGE': // target is user the image is uploaded to
            if (!user) return false
            if (user.role === 'banned') return false
            if (user.id === target.id) return true
            return false
        case 'CHANGE_UNAME': // target is user to have their uname changed
            assert(target)
            assert(Number.isInteger(target.id))
            assert(typeof target.role === 'string')
            // Guests cannot
            if (!user) return false
            // Banned cannot
            if (user.role === 'banned') return false
            // Admin can change anyone's uname
            if (user.role === 'admin') return true
            // Staff can change their own name and the name of any non-staff
            if (isStaffRole(user.role)) {
                if (user.id === target.id) {
                    return true
                } else {
                    return !isStaffRole(target.role)
                }
            }
            // Everyone else can only change their own username
            // if (user.id === target.id) return true
            return false
        //
        // DICE
        //
        case 'UPDATE_CAMPAIGN': // target is campaign
            if (!user) return false
            if (user.role === 'banned') return false
            // people can update their own campaigns
            if (user.id === target.user_id) return true
            // staff can update any campaign
            if (isStaffRole(user.role)) return true
            return false
        case 'READ_CAMPAIGN': // target is campaign
            // anyone can
            return true
        case 'CREATE_CAMPAIGN': // no target
            if (!user) return false
            // anyone that's not banned can
            if (user.role !== 'banned') return true
            return false
        // TODO: yes if they are coGM/GM of target.topic_id
        case 'CREATE_ROLL': // target is campaign
            if (!user) return false
            if (user.role === 'banned') return false
            // can if they own the campaign
            if (user.id === target.user_id) return true
            return false
        //
        // CHAT
        //
        case 'READ_CHATLOGS': // no target
            if (!user) return false
            if (user.id === 107) return true // HACK: Let Ellri
            if (isStaffRole(user.role)) return true // Only staff can
            return false
        //
        // GM/CO-GM
        //
        case 'TOPIC_BAN': // target is { topic, user }
            if (!user) return false
            // Staff cannot be banned
            if (isStaffRole(target.user.role)) return false
            // GM cannot be banned
            if (target.user.id === target.topic.user_id) return false
            // Co-GMs cannot be banned
            if (target.topic.co_gm_ids.includes(target.user.id)) return false
            // Staff can ban
            if (isStaffRole(user.role)) return true
            // GM can ban
            if (user.id === target.topic.user_id) return true
            // Co-GMs can ban
            if (target.topic.co_gm_ids.includes(user.id)) return true
            return false
        default:
            debug('Unsupported cancan action: ' + action)
            return false
    }
}

exports.cannot = function(user, action, target) {
    return !can(user, action, target)
}
