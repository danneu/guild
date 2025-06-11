
# Guild

An ancient forum somehow still running in production.

## Setup and Install

The Guild is a Node.js app that talks to a Postgres database.

- Install the latest stable version of Node.

- The Guild depends on the `plv8` Postgres extension. This extension can sometimes fail to build, so the binary can be found here: https://github.com/plv8/plv8/issues/220

Archive Link: https://web.archive.org/web/20200604033753/https://github.com/plv8/plv8/issues/220

- Download the repository and enter the directory that it created:

        git clone git@github.com:danneu/guild.git
        cd guild

- Enter the `guild` directory and install its dependencies:

        npm install

- Launch Postgres (by default it will run on `http://localhost:5432`) and create an empty database named `guild`.

        createdb guild

- The Guild comes with a command that rebuilds the database with tables and fills them with some data to play with:

        npm run reset-db

- Now you can launch the server:

        npm start
        > Listening on http://localhost:3000

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
