import { google, drive_v3 } from 'googleapis';
import asyncPool from 'tiny-async-pool';
import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { logWithContext } from './logger';
import { failureTracker } from './failureTracker';

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
  const sanitizedName = sanitizeFileName( name );
  const downloadsFolder = path.resolve( parentDir, sanitizedName );
  
  logWithContext.info('Processing folder', {
    folderId: driveFolderId,
    folderName: name,
    sanitizedName,
    parentDir,
    downloadsFolder,
  });

  try {
    if( !fs.existsSync( downloadsFolder ) ) {
      fs.mkdirSync( downloadsFolder, { recursive: true } );
      logWithContext.debug('Created directory', { path: downloadsFolder });
    }
  } catch (error) {
    failureTracker.recordFilesystemFailure('mkdir', downloadsFolder, error, {
      folderId: driveFolderId,
      folderName: name,
    });
    throw error;
  }
  // Get all files using pagination
  const files: drive_v3.Schema$File[] = [];
  let nextPageToken: string | undefined;
  
  try {
    do {
      const listFilesResp = await drive.files.list(
        {
          q: `'${driveFolderId}' in parents and trashed=false`,
          pageSize: 1000,
          pageToken: nextPageToken,
          fields: 'nextPageToken, files(id, name, md5Checksum, size, mimeType)',
        }
      );
      
      const pageFiles = listFilesResp.data.files || [];
      files.push(...pageFiles);
      nextPageToken = listFilesResp.data.nextPageToken || undefined;
      
      logWithContext.info('Retrieved files from folder', {
        folderId: driveFolderId,
        folderName: name,
        pageFilesCount: pageFiles.length,
        totalFilesCount: files.length,
        hasNextPage: !!nextPageToken,
      });
    } while (nextPageToken);
  } catch (error) {
    failureTracker.recordFolderFailure(driveFolderId, name, parentDir, error);
    throw error;
  }
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
      logWithContext.debug('Skipping shortcut file', {
        fileId: f.id,
        fileName: f.name,
        folderPath: downloadsFolder,
      });
      return;
    }

    // Check if it's a folder
    if( f.mimeType === 'application/vnd.google-apps.folder' ) {
      foldersToProcessLater.push( f );
      logWithContext.debug('Deferring folder processing', {
        folderId: f.id,
        folderName: f.name,
        parentPath: downloadsFolder,
      });
      return;
    }

    logWithContext.info('Processing file', {
      fileId: f.id,
      fileName: f.name,
      mimeType: f.mimeType,
      size: f.size,
      folderPath: downloadsFolder,
      progress: `${count}/${files.length}`,
    });

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
    try {
      if( fs.existsSync( filePath ) ) {
        const existingSize = fs.statSync( filePath ).size;
        // For Google Docs files, we can't compare size directly since export size differs
        if( !isGoogleDoc && f.size && existingSize >= parseInt( f.size ) ) {
          logWithContext.debug('Skipping existing file (size match)', {
            fileId: f.id,
            fileName: f.name,
            filePath,
            existingSize,
            expectedSize: f.size,
          });
          return;
        }
        // For Google Docs, skip if file exists and has some content (> 0 bytes)
        if( isGoogleDoc && existingSize > 0 ) {
          logWithContext.debug('Skipping existing Google Doc file', {
            fileId: f.id,
            fileName: f.name,
            filePath,
            existingSize,
          });
          return;
        }
        fs.unlinkSync( filePath );
        logWithContext.debug('Removed incomplete file', {
          fileId: f.id,
          fileName: f.name,
          filePath,
          existingSize,
        });
      }
    } catch (error) {
      failureTracker.recordFilesystemFailure('file_check', filePath, error, {
        fileId: f.id,
        fileName: f.name,
        operation: 'exists/stat/unlink',
      });
      // Continue with download attempt
    }

    let downloadedBytes = 0;
    let dest: fs.WriteStream;
    
    try {
      dest = fs.createWriteStream( filePath );
    } catch (error) {
      failureTracker.recordFilesystemFailure('create_write_stream', filePath, error, {
        fileId: f.id,
        fileName: f.name,
      });
      return Promise.resolve(false);
    }
    
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
              const errorMsg = err || new Error('No response data received');
              failureTracker.recordFileFailure(
                'export',
                f.id!,
                f.name!,
                downloadsFolder,
                f.mimeType!,
                errorMsg,
                { exportMimeType: docInfo.exportMimeType }
              );
              dest.destroy();
              resolve( false );
              return;
            }
            if( err ) {
              failureTracker.recordFileFailure(
                'export',
                f.id!,
                f.name!,
                downloadsFolder,
                f.mimeType!,
                err,
                { exportMimeType: docInfo.exportMimeType }
              );
              dest.destroy();
              resolve( false );
              return;
            }
            resp.data
              .on( 'data', function( chunk ) {
                downloadedBytes += chunk.length;
                process.stdout.write( `${count}/${files.length} ${downloadedBytes} bytes (exported)\r` );
                try {
                  dest.write( chunk );
                } catch (writeError) {
                  failureTracker.recordFilesystemFailure('write_chunk', filePath, writeError, {
                    fileId: f.id,
                    fileName: f.name,
                    bytesWritten: downloadedBytes,
                  });
                }
              } )
              .on( 'end', () => {
                dest.end();
                logWithContext.info('File exported successfully', {
                  fileId: f.id,
                  fileName: f.name,
                  filePath,
                  bytesDownloaded: downloadedBytes,
                  mimeType: f.mimeType,
                  exportMimeType: docInfo.exportMimeType,
                });
                resolve( true );
              } )
              .on( 'error', ( streamError ) => {
                failureTracker.recordFileFailure(
                  'stream',
                  f.id!,
                  f.name!,
                  downloadsFolder,
                  f.mimeType!,
                  streamError,
                  { 
                    type: 'export_stream',
                    bytesDownloaded: downloadedBytes,
                  }
                );
                dest.destroy();
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
              const errorMsg = err || new Error('No response data received');
              failureTracker.recordFileFailure(
                'download',
                f.id!,
                f.name!,
                downloadsFolder,
                f.mimeType!,
                errorMsg
              );
              dest.destroy();
              resolve( false );
              return;
            }
            if( err ) {
              failureTracker.recordFileFailure(
                'download',
                f.id!,
                f.name!,
                downloadsFolder,
                f.mimeType!,
                err
              );
              dest.destroy();
              resolve( false );
              return;
            }
            resp.data
              .on( 'data', function( chunk ) {
                downloadedBytes += chunk.length;
                process.stdout.write( `${count}/${files.length} ${downloadedBytes}/${f.size || 'unknown'}\r` );
                try {
                  dest.write( chunk );
                } catch (writeError) {
                  failureTracker.recordFilesystemFailure('write_chunk', filePath, writeError, {
                    fileId: f.id,
                    fileName: f.name,
                    bytesWritten: downloadedBytes,
                  });
                }
              } )
              .on( 'end', () => {
                dest.end();
                logWithContext.info('File downloaded successfully', {
                  fileId: f.id,
                  fileName: f.name,
                  filePath,
                  bytesDownloaded: downloadedBytes,
                  expectedSize: f.size,
                  mimeType: f.mimeType,
                });
                resolve( true );
              } )
              .on( 'error', ( streamError ) => {
                failureTracker.recordFileFailure(
                  'stream',
                  f.id!,
                  f.name!,
                  downloadsFolder,
                  f.mimeType!,
                  streamError,
                  { 
                    type: 'download_stream',
                    bytesDownloaded: downloadedBytes,
                    expectedSize: f.size,
                  }
                );
                dest.destroy();
                resolve( false );
              } );
          }
        );
      }
    } );
  } ) ) {
    // Process result value if needed
    if( value === false ) {
      logWithContext.debug('File processing returned false', {
        folderPath: downloadsFolder,
      });
    }
  }

  logWithContext.info('Completed processing files in folder', {
    folderId: driveFolderId,
    folderName: name,
    folderPath: downloadsFolder,
    filesProcessed: files.length,
    foldersToProcess: foldersToProcessLater.length,
  });

  // Process subfolders recursively
  for( const folder of foldersToProcessLater ) {
    try {
      await downloadFolder( folder.id!, folder.name!, downloadsFolder );
    } catch (error) {
      failureTracker.recordFolderFailure(
        folder.id!,
        folder.name!,
        downloadsFolder,
        error
      );
      // Continue processing other folders even if one fails
      logWithContext.warn('Failed to process subfolder, continuing with others', {
        folderId: folder.id,
        folderName: folder.name,
        parentPath: downloadsFolder,
      });
    }
  }
}

logWithContext.info('Starting drive sync operation', {
  folderId: argv.folder,
  outputPath: argv.output,
  concurrency: argv.concurrency,
  secretFile: argv.secret,
});

downloadFolder( argv.folder, '', argv.output ).catch( err => {
  failureTracker.recordFolderFailure(
    argv.folder,
    'root',
    argv.output,
    err
  );
  logWithContext.error('Fatal error during sync operation', err, {
    folderId: argv.folder,
    outputPath: argv.output,
  });
  process.exit(1);
} ).finally( () => {
  failureTracker.printSummary();
  logWithContext.info('Drive sync operation completed', {
    folderId: argv.folder,
    outputPath: argv.output,
  });
} );