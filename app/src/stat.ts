import { config } from 'dotenv-flow';
import type { drive_v3 } from 'googleapis';
import { google } from 'googleapis';
import asyncPool from 'tiny-async-pool';
import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import type { GaxiosResponse } from 'gaxios';

type TTree = Pick<drive_v3.Schema$File, 'id' | 'mimeType' | 'name' | 'size'> & { children: TTree[] };

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

  // Recursive function to build the folder structure tree
  function buildTree( files: drive_v3.Schema$File[], parentId: string | null = null ): TTree[] {
    const tree = files
      .filter( ( file ) => file.parents && ( !parentId || file.parents.includes( parentId ) ) )
      .map( ( file ) => ( {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
        children: buildTree( files, file.id ),
      } ) );

    return tree;
  }

  // Recursive function to display the tree structure
  function displayTree( tree: TTree[], indent = '' ): void {
    tree.forEach( ( node ) => {
      console.log( `${indent}${node.name} (${node.size} bytes)` );

      if( node.children && node.children.length > 0 ) {
        displayTree( node.children, indent + '--' );
      }
    } );
  }

  async function listAllFiles(): Promise<void> {
    let files: drive_v3.Schema$File[] = [];
    let nextPageToken: string | undefined = '';

    // Fetch all files and folders
    while( nextPageToken !== undefined && nextPageToken !== null ) {
      // Explicitly typing the response
      const resp: GaxiosResponse<drive_v3.Schema$FileList> = await drive.files.list( {
        q: '\'me\' in owners',
        pageSize: 1000, // Set page size as needed
        fields: 'nextPageToken, files(id, name, mimeType, size, parents)',
        pageToken: nextPageToken,
        // orderBy: 'quotaBytesUsed desc',
      } );
      console.log( `numFiles: ${resp.data.files?.length}, nextPageToken: ${nextPageToken}` );

      if( resp.data.files ) {
        files = files.concat( resp.data.files );
      }

      if( !resp.data.nextPageToken ) {
        break;
      }

      nextPageToken = resp.data.nextPageToken;
    }

    // Build tree from the list of files
    const tree = buildTree( files, null );

    // Display the tree structure
    displayTree( tree );

    for( const file of files ) {
      if( !file.id ) {
        continue;
      }
      await drive.files.delete( {
        fileId: file.id,
      } );
      console.log( 'Deleted', file.name, file.id );
    }
  }

  // try {
  //   // Fetch the storage quota using the 'about' endpoint
  //   const res = await drive.about.get( { fields: 'storageQuota' } );

  //   if( res.data.storageQuota ) {
  //     console.log( 'Storage Quota:' );
  //     console.log( `  Total: ${res.data.storageQuota.limit}` );
  //     console.log( `  Used: ${res.data.storageQuota.usage}` );
  //     console.log( `  Drive Used: ${res.data.storageQuota.usageInDrive}` );
  //     console.log( `  Trash Used: ${res.data.storageQuota.usageInDriveTrash}` );
  //   } else {
  //     console.log( 'Unable to fetch storage quota.' );
  //   }
  // } catch( err ) {
  //   console.error( 'Error fetching storage quota:', err );
  // }

  await listAllFiles();
};

main().finally( () => {
  console.log( 'Done!' );
} );