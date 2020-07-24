
# Guild

[![Dependency Status](https://david-dm.org/danneu/guild.svg)](https://david-dm.org/danneu/guild)

A forum running in production.

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

## Config and Environment Variables

The Guild is configured with environment variable listed in [server/config.js](https://github.com/danneu/guild/blob/master/server/config.js).

It will run with the default variables, but some features are turned off until they are configured:

- Email-sending system requires `AWS_KEY` and `AWS_SECRET` (your http://aws.amazon.com/ API creds)
- User registration system requires `RECAPTCHA_SITEKEY` and `RECAPTCHA_SITESECRET` (your https://www.google.com/recaptcha/intro/index.html API creds)
