// eflags holds the bit flags for email notification settings.
//
// Just brainstorming.  This prob isn't sufficient long term once we get into per-topic/per-rp notification settings.
//
// Note using emailer.js because I want to replace it with simpler code.

const NEW_CONVO = 0b000001 // recv new convo (so, only recv notif on first pm of a convo)
const ANY_PM    = 0b000010 // recv any pm
const SUB_RP    = 0b000100 // roleplay subscriptions
const SUB_NORP  = 0b001000 // non-roleplay subscriptions
const REACTION  = 0b010000 // like | laugh | thanks
const MENTION   = 0b100000 // mention or quote

module.exports = {
    NEW_CONVO
}
