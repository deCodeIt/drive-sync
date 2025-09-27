import { config } from 'dotenv-flow';
import { google } from 'googleapis';
import asyncPool from 'tiny-async-pool';
import fs from 'fs';
import path from 'path';

config();

const credentialFilename = path.resolve( __dirname, `../secret/${process.env.SECRET_FILE}` );
const scopes = [ 'https://www.googleapis.com/auth/drive' ];

const auth = new google.auth.GoogleAuth( { keyFile: credentialFilename, scopes: scopes } );
const drive = google.drive( { version: 'v3', auth } );

// Google Docs Editor MIME types that need to be exported instead of downloaded
const GOOGLE_DOCS_MIME_TYPES = {
  'application/vnd.google-apps.document': { extension: '.docx', exportMimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  'application/vnd.google-apps.spreadsheet': { extension: '.xlsx', exportMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  'application/vnd.google-apps.presentation': { extension: '.pptx', exportMimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  'application/vnd.google-apps.drawing': { extension: '.png', exportMimeType: 'image/png' },
  'application/vnd.google-apps.script': { extension: '.json', exportMimeType: 'application/vnd.google-apps.script+json' },
  'application/vnd.google-apps.form': { extension: '.zip', exportMimeType: 'application/zip' }
};

const googleDocsMimeTypes = Object.keys(GOOGLE_DOCS_MIME_TYPES);

function isGoogleDocsFile(mimeType: string): boolean {
  return googleDocsMimeTypes.includes(mimeType);
}

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

    // Determine the correct file path and extension
    let fileName = f.name!;
    let filePath = path.resolve( downloadsFolder, fileName );
    
    // For Google Docs Editor files, add the appropriate extension
    if( isGoogleDocsFile( f.mimeType! ) ) {
      const docInfo = GOOGLE_DOCS_MIME_TYPES[f.mimeType! as keyof typeof GOOGLE_DOCS_MIME_TYPES];
      if( !fileName.endsWith( docInfo.extension ) ) {
        fileName += docInfo.extension;
        filePath = path.resolve( downloadsFolder, fileName );
      }
    }

    // Skip if file already exists and has reasonable size
    if( fs.existsSync( filePath ) ) {
      const existingSize = fs.statSync( filePath ).size;
      // For Google Docs files, we can't compare size directly since export size differs
      if( !isGoogleDocsFile( f.mimeType! ) && existingSize >= parseInt( f.size! ) ) {
        return;
      }
      // For Google Docs, skip if file exists and has some content (> 0 bytes)
      if( isGoogleDocsFile( f.mimeType! ) && existingSize > 0 ) {
        return;
      }
      fs.unlinkSync( filePath );
    }

    let downloadedBytes = 0;
    const dest = fs.createWriteStream( filePath );
    
    return new Promise( ( resolve ) => {
      // Handle Google Docs Editor files with export
      if( isGoogleDocsFile( f.mimeType! ) ) {
        const docInfo = GOOGLE_DOCS_MIME_TYPES[f.mimeType! as keyof typeof GOOGLE_DOCS_MIME_TYPES];
        drive.files.export(
          { 
            fileId: f.id!, 
            mimeType: docInfo.exportMimeType 
          },
          { responseType: 'stream' },
          ( err, resp ) => {
            if( !resp?.data ) {
              console.warn( 'No data for export:', f.name );
              resolve( false );
              return;
            }
            if( err ) {
              console.error( 'Export error:', err );
              resolve( false );
              return;
            }
            resp.data
              .on( 'data', function( chunk ) {
                downloadedBytes += chunk.length;
                process.stdout.write( `${count}/${files.length} ${downloadedBytes} bytes (exported)\r` );
                dest.write( chunk );
              } )
              .on( 'end', () => {
                console.log( `Done (exported): ${fileName}` );
                dest.close();
                resolve( true );
              } )
              .on( 'error', ( errr ) => {
                console.log( 'Stream error:', errr );
                resolve( false );
              } );
          }
        );
      } else {
        // Handle regular files with download
        drive.files.get(
          { fileId: f.id!, alt: 'media', acknowledgeAbuse: true },
          { responseType: 'stream' },
          ( err, resp ) => {
            if( !resp?.data ) {
              console.warn( 'No data for download:', f.name );
              resolve( false );
              return;
            }
            if( err ) {
              console.error( 'Download error:', err );
              resolve( false );
              return;
            }
            resp.data
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
                console.log( 'Stream error:', errr );
                resolve( false );
              } );
          }
        );
      }
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