## Drive Sync CLI Tool  
A command-line tool to sync Google Drive folders to your local machine with support for Google Docs Editor files (Docs, Sheets, Slides).

### Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Add your service account key**
   - Place your Google service account JSON key file in the `app/secret/` folder
   - Example: `app/secret/drive-sync-key-sa.json`

### Usage

```bash
npm start -- [options]
```

#### Options

- `--secret, -s`: Service account key file name (in secret/ folder) **[required]**
- `--folder, -f`: Google Drive folder ID to sync **[required]**
- `--output, -o`: Local directory path for downloads **[required]**
- `--concurrency, -c`: Number of concurrent downloads (default: 5)
- `--help, -h`: Show help

#### Examples

```bash
# Basic usage
npm start -- --secret drive-sync-key-sa.json --folder 1ABC123xyz --output /path/to/local/folder

# Using short flags
npm start -- -s key.json -f 1ABC123xyz -o ./downloads

# With custom concurrency (10 concurrent downloads)
npm start -- -s key.json -f 1ABC123xyz -o ./downloads -c 10

# Show help
npm start -- --help
```

### Features

- **Google Docs Editor Support**: Automatically exports Google Docs, Sheets, Slides as Office formats (.docx, .xlsx, .pptx)
- **Concurrent Downloads**: Configurable number of parallel downloads for faster syncing
- **Resume Support**: Skips already downloaded files based on size comparison
- **Recursive Folder Sync**: Maintains folder structure from Google Drive
- **Conflict Resolution**: Handles duplicate filenames and folder/file conflicts