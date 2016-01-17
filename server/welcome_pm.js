'use strict';
// 3rd party
// ...
// 1st party
var bbcode = require('./bbcode');

// Markup and HTML for the welcome/introductory PM
var welcomeMarkup = `
[center][h1]Welcome to the Roleplayer Guild![/h1][/center]

We are an ever-growing community of enthusiastic and dedicated play-by-post roleplayers that cater to all genres and playstyles - fantasy, sci-fi, romance and even tabletop & nation roleplays. First founded in 2007, the Guild has been the go-to forum for thousands of members since its inception. We sport an easy-to-navigate forum layout and a plethora of nifty features implemented specifically to improve the roleplaying experience.

[list]
[*]Feeling a little overwhelmed? It is [b]highly[/b] recommended that you read the [url=http://www.roleplayerguild.com/topics/4958/posts/ooc]New User's Guide[/url], which explains the various purposes of our different subforums and is full of useful links & information.
[*]Please familiarize yourself with the [url=http://www.roleplayerguild.com/topics/531/posts/ooc]Fundamental Rules of the Guild[/url]. Don't worry, there aren't many.
[*]The Guild is currently undergoing development. Features that are missing will be implemented in the future and existing functionality will keep improving. Keep an eye on [url=http://www.roleplayerguild.com/topics/75056/posts/ooc]Mahz's Dev Journal[/url] to stay up to date with the changes.
[*]Last but not least, the [url=http://www.roleplayerguild.com/forums/2]Introduce Yourself[/url] subforum is a great way to introduce yourself to our community and make a good first impression. Also be sure to check out the [url=http://www.roleplayerguild.com/chat]Guild's Chat[/url] where our members frequently hang out.[/list]

We hope you enjoy your stay at the Roleplayer Guild. :sun

Yours sincerely,
The Roleplayer Guild Staff
`;

var welcomeHtml = bbcode(welcomeMarkup);

module.exports = {
  markup: welcomeMarkup,
  html: welcomeHtml
};
