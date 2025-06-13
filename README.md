
# Guild

An ancient forum somehow still running in production.

- Started as a vBulletin forum in 2006 when I was 17
- Unfortunately deleted in 2015 (Guildfall) [Wayback Machine example](https://web.archive.org/web/20100915043234/http://roleplayerguild.com/)
- Written from scratch with Clojure and Datomic in 2015 (don't ask)
- Ported to Node.js and Postgres starting in 2018 (ongoing infiniwork)

## Setup and Install

The Guild is a Node.js app that talks to a Postgres database.

- Install the latest stable version of Node.
- Download the repository and install its dependencies:

  ```sh
  git clone git@github.com:danneu/guild.git
  cd guild
  npm install
  ```

- Launch Postgres (by default it will run on `http://localhost:5432`) and create an empty database named `guild`.

  ```sh
  createdb guild
  ```

- The Guild comes with a command that rebuilds the database with tables and fills them with some data to play with:

  ```sh
  npm run reset-db
  ```

- Now you can launch the server:

  ```sh
  npm start
  > Listening on port 3000
  ```

## Building js/css assets

The guild uses [gulp](https://gulpjs.com) to build assets into the folder `./dist/` which will include a manifest file `./dist/rev-manifest.json` that contains the name of the bundles.

```
dist/
    fonts/
        all-155a92ba49.js
        all-bfacf3040f.css
        rev-manifest.json
```

You can run the task with:

```sh
npm run assets
```

If the dist folder exists, then the compiled js/css/fonts bundles will be served. 

Otherwise, i.e. for development, all of the js/css/font files are loaded individually and uncompiled.

In other words, you must run `npm run assets` in production for the compiled assets to be served, and you must also remember to rebuild them when they change, else stale bundles will be served.


## Config and Environment Variables

The Guild is configured with environment variable listed in [server/config.js](https://github.com/danneu/guild/blob/master/server/config.js).

It will run with the default variables, but some features are turned off until they are configured:

- Email-sending system requires `AWS_KEY` and `AWS_SECRET` (your http://aws.amazon.com/ API creds)
- User registration system requires `CF_TURNSTILE_SITEKEY` and `CF_TURNSTILE_SECRET` (your https://www.cloudflare.com/turnstile/ API creds)
