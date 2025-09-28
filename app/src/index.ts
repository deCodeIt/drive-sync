import { google } from 'googleapis';
import asyncPool from 'tiny-async-pool';
import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// Parse command line arguments with yargs
const argv = yargs(hideBin(process.argv))
  .option('secret', {
    alias: 's',
    type: 'string',
    description: 'Service account key file name (in secret/ folder)',
    demandOption: true
  })
  .option('folder', {
    alias: 'f',
    type: 'string',
    description: 'Google Drive folder ID to sync',
    demandOption: true
  })
  .option('output', {
    alias: 'o',
    type: 'string',
    description: 'Local directory path for downloads',
    demandOption: true
  })
  .option('concurrency', {
    alias: 'c',
    type: 'number',
    description: 'Number of concurrent downloads',
    default: 5
  })
  .help()
  .alias('help', 'h')
  .example('$0 --secret drive-sync-key-sa.json --folder 1ABC123xyz --output /path/to/folder', 'Download Google Drive folder')
  .example('$0 -s key.json -f 1ABC123xyz -o ./downloads -c 3', 'Download with 3 concurrent downloads')
  .parseSync();

const credentialFilename = path.resolve( __dirname, `../secret/${argv.secret}` );
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

function sanitizeFileName(fileName: string): string {
  // Replace characters that are problematic in file/folder names with hyphens
  return fileName
    .replace(/[\/\\:*?"<>|]/g, '-')  // Replace all problematic characters with hyphen
    .replace(/-+/g, '-')             // Replace multiple consecutive hyphens with single hyphen
    .replace(/^-+|-+$/g, '')         // Remove leading and trailing hyphens
    .trim();
}

function isShortcut(mimeType: string): boolean {
  return mimeType === 'application/vnd.google-apps.shortcut';
}

async function downloadFolder( driveFolderId: string, name: string, parentDir: string ): Promise<void> {
  console.log( 'downloadFolder', parentDir, name, driveFolderId );
  const sanitizedName = sanitizeFileName( name );
  const downloadsFolder = path.resolve( parentDir, sanitizedName );
  if( !fs.existsSync( downloadsFolder ) ) {
    fs.mkdirSync( downloadsFolder, { recursive: true } );
  }
  const listFilesResp = await drive.files.list(
    {
      q: `'${driveFolderId}' in parents and trashed=false`,
      pageSize: 1000,
      fields: 'nextPageToken, files(id, name, md5Checksum, size, mimeType)',
    }
  );

  const files = listFilesResp.data.files || [];
  // console.log( files );

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

  for await( const value of asyncPool( argv.concurrency, files, async ( f ) => {
    count++;
    
    // Skip shortcuts entirely
    if( isShortcut( f.mimeType! ) ) {
      console.log( `Skipping shortcut: ${f.name}` );
      return;
    }

    // Check if it's a folder
    if( f.mimeType === 'application/vnd.google-apps.folder' ) {
      foldersToProcessLater.push( f );
      return;
    }

    console.log( `Processing file: ${f.name} (${f.mimeType}) (${f.id})` );

    // Cache the Google Docs check to avoid multiple calls
    const isGoogleDoc = isGoogleDocsFile( f.mimeType! );
    
    // Determine the correct file path and extension
    let fileName = sanitizeFileName( f.name! );
    let filePath = path.resolve( downloadsFolder, fileName );
    
    // For Google Docs Editor files, add the appropriate extension
    if( isGoogleDoc ) {
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
      if( !isGoogleDoc && f.size && existingSize >= parseInt( f.size ) ) {
        return;
      }
      // For Google Docs, skip if file exists and has some content (> 0 bytes)
      if( isGoogleDoc && existingSize > 0 ) {
        return;
      }
      fs.unlinkSync( filePath );
    }

    let downloadedBytes = 0;
    const dest = fs.createWriteStream( filePath );
    
    return new Promise( ( resolve ) => {
      // Handle Google Docs Editor files with export
      if( isGoogleDoc ) {
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
              if( err ) {
                console.error( 'Export error:', err );
              }
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
              if( err ) {
                console.error( 'Download error:', err );
              }
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
                process.stdout.write( `${count}/${files.length} ${downloadedBytes}/${f.size || 'unknown'}\r` );
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

downloadFolder( argv.folder, '', argv.output ).catch( err => {
  console.error( err );
} ).finally( () => {
  console.log( 'Done!' );
} );