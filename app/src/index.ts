import { config } from 'dotenv-flow';
import { google } from 'googleapis';
import asyncPool from 'tiny-async-pool';
import fs from 'fs';
import path from 'path';

config();

const credentialFilename = path.resolve( __dirname, '../secret/drive-sync-key-sa.json' );
const scopes = [ 'https://www.googleapis.com/auth/drive' ];

const auth = new google.auth.GoogleAuth( { keyFile: credentialFilename, scopes: scopes } );
const drive = google.drive( { version: 'v3', auth } );

async function downloadFolder( driveFolderId: string, name: string, parentDir: string ): Promise<void> {
  console.log( 'downloadFolder', parentDir, name, driveFolderId );
  const downloadsFolder = path.resolve( parentDir, name );
  if( !fs.existsSync( downloadsFolder ) ) {
    fs.mkdirSync( downloadsFolder );
  }
  const listFilesResp = await drive.files.list(
    {
      q: `'${driveFolderId}' in parents and trashed=false`,
      pageSize: 1000,
      fields: 'nextPageToken, files(id, name, md5Checksum, size, mimeType)',
    }
  );

  const files = listFilesResp.data.files || [];
  console.log( files );

  // const fileSet = new Set<string | null | undefined>();
  // files.forEach( f => {
  //   const { name } = f;
  //   if( fileSet.has( name ) ) {
  //     console.log( 'Duplicate Name', name );
  //   }
  //   fileSet.add( name );
  // } );
  // console.log( files.length, fileSet.size );

  const foldersToProcessLater: typeof files = [];
  let count = 0;

  for await( const value of asyncPool( 5, files, async ( f ) => {
    count++;
    if( f.mimeType === 'application/vnd.google-apps.folder' ) {
      foldersToProcessLater.push( f );
      return;
    }
    const filePath = path.resolve( downloadsFolder, f.name! );
    if( fs.existsSync( filePath ) ) {
      if( fs.statSync( filePath ).size >= parseInt( f.size! ) ) {
        return;
      }
      fs.unlinkSync( filePath );
    }

    let downloadedBytes = 0;
    const dest = fs.createWriteStream( filePath );
    return new Promise( ( resolve ) => {
      drive.files.get(
        { fileId: f.id!, alt: 'media', acknowledgeAbuse: true },
        { responseType: 'stream' },
        ( err, resp ) => {
          if( !resp?.data ) {
            console.warn( 'No data' );
            resolve( false );
          }
          if( err ) {
            console.error( err );
            resolve( false );
          }
          resp?.data
            .on( 'data', function( chunk ) {
              downloadedBytes += chunk.length;
              process.stdout.write( `${count}/${files.length} ${downloadedBytes}/${f.size}\r` );
              dest.write( chunk );
            } )
            .on( 'end', () => {
              console.log( `Done: ${f.name}` );
              dest.close();
              resolve( true );
            } )
            .on( 'error', ( errr ) => {
              console.log( errr );
              resolve( false );
            } );
        }
      );
    } );
  } ) ) {
    console.log( 'Value:', value );
  }

  console.log( 'foldersToProcessLater', foldersToProcessLater );

  for( const folder of foldersToProcessLater ) {
    await downloadFolder( folder.id!, folder.name!, downloadsFolder );
  }
}

downloadFolder( process.env.DRIVE_FOLDER_ID!, '', process.env.LOCAL_DIR! ).catch( err => {
  console.error( err );
} ).finally( () => {
  console.log( 'Done!' );
} );