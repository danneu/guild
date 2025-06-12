import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses'
import assert from 'assert'

// TODO: Replace emailer.js


export const sendEmail = async ({ fromName, fromEmail, toEmails, subject, bodyText}) => {
    assert(typeof fromName === 'string')
    assert(typeof fromEmail === 'string')
    assert(Array.isArray(toEmails))
    assert(toEmails.every(email => typeof email === 'string'))
    assert(toEmails.length > 0)
    assert(typeof subject === 'string')
    assert(typeof bodyText === 'string')

    const client = new SESClient({ region: 'us-east-1'})
    const sender = `${rfc2047Encode(fromName)} <${fromEmail}>`

    const options = {
        Source: sender,
        Destination: { 
            BccAddresses: toEmails,
        }, 
        Message: {
         Subject: { Charset: 'UTF-8', Data: subject },
         Body: { Text: { Charset: 'UTF-8', Data: bodyText }, }, 
        }, 
       }
    const command = new SendEmailCommand(options);
    return await client.send(command)
}

function rfc2047Encode(str) {
    const encodedWords = str.split(' ').map(word => {
      if (/[\x00-\x7F]+/.test(word)) {
        return word;
      } else {
        return '=?UTF-8?B?' +
          Buffer.from(word, 'utf-8').toString('base64') + '?=';
      }
    });
    return encodedWords.join(' ');
}
