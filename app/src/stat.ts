import { config } from 'dotenv-flow';
import { google } from 'googleapis';
import asyncPool from 'tiny-async-pool';
import fs from 'fs';
import path from 'path';
import yargs from 'yargs';

config();

const main = async () => {

  const argv = await yargs
    .options(
      {
        'k': {
          alias: 'keyfile',
          demandOption: true,
          describe: 'Service account key file',
          type: 'string',
        },
      }
    ).argv;


  const credentialFilename = path.resolve( __dirname, `../secret/${argv.k}.json` );
  const scopes = [ 'https://www.googleapis.com/auth/drive' ];

  const auth = new google.auth.GoogleAuth( { keyFile: credentialFilename, scopes: scopes } );
  const drive = google.drive( { version: 'v3', auth } );

  try {
    // Fetch the storage quota using the 'about' endpoint
    const res = await drive.about.get( { fields: 'storageQuota' } );

    if( res.data.storageQuota ) {
      console.log( 'Storage Quota:' );
      console.log( `  Total: ${res.data.storageQuota.limit}` );
      console.log( `  Used: ${res.data.storageQuota.usage}` );
      console.log( `  Drive Used: ${res.data.storageQuota.usageInDrive}` );
      console.log( `  Trash Used: ${res.data.storageQuota.usageInDriveTrash}` );
    } else {
      console.log( 'Unable to fetch storage quota.' );
    }
  } catch( err ) {
    console.error( 'Error fetching storage quota:', err );
  }
};

main().finally( () => {
  console.log( 'Done!' );
} );