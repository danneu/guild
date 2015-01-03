
# Guild

Work in progress

## Setup and Install

The Guild is a Node.js app (v0.11.x) that talks to a Postgres database.

It depends on the environment variables found here: https://github.com/danneu/guild/blob/master/server/config.js

Download the repository and enter the directory from the command line:

    git clone git@github.com:danneu/guild.git

Enter the `guild` directory and install its dependencies:

    npm install

(Installing Node.js is what gives you that `npm` command)

Launch Postgres (by default it will run on `http://localhost:5432`) and create an empty database named `guild`.

The Guild comes with a command that rebuilds the database with tables and fills them with some data to play with:

    npm run-script reset-db

Now you can launch the server:

    npm start
    > Listening on http://localhost:3000

## TODO

- Add tests for authorization abstraction
- Consider merging post and pm logic (db fns, routes, views)
