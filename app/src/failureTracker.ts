import { logWithContext } from './logger';

export interface FailureRecord {
  type: 'file' | 'folder' | 'export' | 'download' | 'stream' | 'filesystem';
  fileId?: string;
  fileName?: string;
  folderPath?: string;
  folderId?: string;
  mimeType?: string;
  error: string;
  errorDetails?: unknown;
  timestamp: string;
}

class FailureTracker {
  private failures: FailureRecord[] = [];

  /**
   * Record a file download/export failure
   */
  recordFileFailure(
    type: 'export' | 'download' | 'stream',
    fileId: string,
    fileName: string,
    folderPath: string,
    mimeType: string | undefined,
    error: Error | unknown,
    errorDetails?: unknown
  ): void {
    const failure: FailureRecord = {
      type,
      fileId,
      fileName,
      folderPath,
      mimeType,
      error: error instanceof Error ? error.message : String(error),
      errorDetails: errorDetails || (error instanceof Error ? { stack: error.stack } : error),
      timestamp: new Date().toISOString(),
    };

    this.failures.push(failure);

    logWithContext.error(
      `Failed to ${type} file`,
      error,
      {
        fileId,
        fileName,
        folderPath,
        mimeType,
        failureType: type,
      }
    );
  }

  /**
   * Record a folder processing failure
   */
  recordFolderFailure(
    folderId: string,
    folderName: string,
    parentPath: string,
    error: Error | unknown,
    errorDetails?: unknown
  ): void {
    const failure: FailureRecord = {
      type: 'folder',
      folderId,
      fileName: folderName,
      folderPath: parentPath,
      error: error instanceof Error ? error.message : String(error),
      errorDetails: errorDetails || (error instanceof Error ? { stack: error.stack } : error),
      timestamp: new Date().toISOString(),
    };

    this.failures.push(failure);

    logWithContext.error(
      `Failed to process folder`,
      error,
      {
        folderId,
        folderName,
        parentPath,
        failureType: 'folder',
      }
    );
  }

  /**
   * Record a filesystem operation failure
   */
  recordFilesystemFailure(
    operation: string,
    filePath: string,
    error: Error | unknown,
    context?: Record<string, unknown>
  ): void {
    const failure: FailureRecord = {
      type: 'filesystem',
      fileName: filePath,
      error: error instanceof Error ? error.message : String(error),
      errorDetails: {
        operation,
        ...context,
        ...(error instanceof Error ? { stack: error.stack } : {}),
      },
      timestamp: new Date().toISOString(),
    };

    this.failures.push(failure);

    logWithContext.error(
      `Filesystem operation failed: ${operation}`,
      error,
      {
        filePath,
        operation,
        ...context,
      }
    );
  }

  /**
   * Get all recorded failures
   */
  getFailures(): FailureRecord[] {
    return [...this.failures];
  }

  /**
   * Get failures by type
   */
  getFailuresByType(type: FailureRecord['type']): FailureRecord[] {
    return this.failures.filter(f => f.type === type);
  }

  /**
   * Get summary statistics
   */
  getSummary(): {
    total: number;
    byType: Record<string, number>;
    byFolder: Record<string, number>;
  } {
    const byType: Record<string, number> = {};
    const byFolder: Record<string, number> = {};

    this.failures.forEach(failure => {
      byType[failure.type] = (byType[failure.type] || 0) + 1;
      if (failure.folderPath) {
        byFolder[failure.folderPath] = (byFolder[failure.folderPath] || 0) + 1;
      }
    });

    return {
      total: this.failures.length,
      byType,
      byFolder,
    };
  }

  /**
   * Print summary report
   */
  printSummary(): void {
    const summary = this.getSummary();

    if (summary.total === 0) {
      logWithContext.info('No failures recorded during sync operation');
      return;
    }

    logWithContext.warn('=== FAILURE SUMMARY ===', {
      totalFailures: summary.total,
      failuresByType: summary.byType,
      failuresByFolder: summary.byFolder,
    });

    // Group failures by folder for easier debugging
    const failuresByFolder = new Map<string, FailureRecord[]>();
    this.failures.forEach(failure => {
      const key = failure.folderPath || 'unknown';
      if (!failuresByFolder.has(key)) {
        failuresByFolder.set(key, []);
      }
      failuresByFolder.get(key)!.push(failure);
    });

    failuresByFolder.forEach((folderFailures, folderPath) => {
      logWithContext.warn(`Failures in folder: ${folderPath}`, {
        count: folderFailures.length,
        files: folderFailures.map(f => ({
          fileName: f.fileName,
          type: f.type,
          error: f.error,
        })),
      });
    });
  }

  /**
   * Clear all recorded failures
   */
  clear(): void {
    this.failures = [];
  }
}

// Export singleton instance
export const failureTracker = new FailureTracker();

