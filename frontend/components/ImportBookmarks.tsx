import { useEffect, useRef, useState } from "react";
import { useApp } from "../context/AppContext.tsx";
import type {
  ImportResponse,
  ImportStatusResponse,
} from "../../shared/types.ts";

type ImportState =
  | { status: "idle" }
  | { status: "uploading" }
  | {
    status: "processing";
    jobId: string;
    progress: ImportStatusResponse;
  }
  | { status: "complete"; result: ImportStatusResponse }
  | { status: "error"; message: string };

const POLL_INTERVAL = 2000;

export function ImportBookmarks() {
  const [importState, setImportState] = useState<ImportState>({
    status: "idle",
  });
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<number | null>(null);
  const { loadInitialData } = useApp();

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function handleFileSelect(file: File | null) {
    setSelectedFile(file);
    setImportState({ status: "idle" });
  }

  function startPolling(jobId: string) {
    if (pollRef.current) clearInterval(pollRef.current);

    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/import/status/${jobId}`);
        if (!res.ok) return;

        const data: ImportStatusResponse = await res.json();

        if (data.status === "complete") {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setImportState({ status: "complete", result: data });
          setSelectedFile(null);
          if (fileInputRef.current) fileInputRef.current.value = "";
          await loadInitialData();
        } else if (data.status === "failed") {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setImportState({
            status: "error",
            message: (data as any).error || "Import failed during processing",
          });
        } else {
          setImportState({
            status: "processing",
            jobId,
            progress: data,
          });
        }
      } catch {
        // Network error — keep polling, it may recover
      }
    }, POLL_INTERVAL) as unknown as number;
  }

  async function handleImport() {
    if (!selectedFile) return;

    setImportState({ status: "uploading" });

    try {
      const formData = new FormData();
      formData.append("file", selectedFile);

      const response = await fetch("/api/import", {
        method: "POST",
        body: formData,
      });

      const data: ImportResponse = await response.json();

      if (!response.ok || !data.success) {
        setImportState({
          status: "error",
          message: data.error || "Import failed",
        });
        return;
      }

      // If a jobId was returned, switch to polling mode
      if (data.jobId) {
        setImportState({
          status: "processing",
          jobId: data.jobId,
          progress: {
            status: "processing",
            imported: 0,
            skipped: data.result?.skipped || 0,
            failed: 0,
            total: data.result?.total || 0,
            format: data.result?.format || "",
            progress: 0,
          },
        });
        startPolling(data.jobId);
        return;
      }

      // No jobId means synchronous completion (e.g. all duplicates)
      setImportState({
        status: "complete",
        result: {
          status: "complete",
          imported: data.result?.imported || 0,
          skipped: data.result?.skipped || 0,
          failed: data.result?.failed || 0,
          total: data.result?.total || 0,
          format: data.result?.format || "",
          progress: 100,
        },
      });
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await loadInitialData();
    } catch (err: any) {
      setImportState({
        status: "error",
        message: err.message || "Import failed",
      });
    }
  }

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-3xl font-bold text-gray-800 mb-3">
          Import Bookmarks
        </h2>
        <p className="text-gray-700 text-lg">
          Bring your bookmarks from other services into kipclip.
        </p>
      </section>

      <section className="bg-white rounded-lg shadow-md p-6">
        {/* Drop zone */}
        <div
          className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
            dragOver ? "border-coral bg-coral/5" : "border-gray-300 bg-gray-50"
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files[0];
            if (file) handleFileSelect(file);
          }}
        >
          {selectedFile
            ? (
              <div>
                <p className="text-gray-800 font-medium mb-1">
                  {selectedFile.name}
                </p>
                <p className="text-sm text-gray-500 mb-4">
                  {(selectedFile.size / 1024).toFixed(1)} KB
                </p>
                <div className="flex gap-3 justify-center">
                  <button
                    type="button"
                    onClick={handleImport}
                    disabled={importState.status === "uploading" ||
                      importState.status === "processing"}
                    className="px-6 py-2 rounded-lg font-bold text-white shadow hover:shadow-md transition disabled:opacity-50"
                    style={{ backgroundColor: "var(--coral)" }}
                  >
                    {importState.status === "uploading"
                      ? "Uploading..."
                      : "Import Bookmarks"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedFile(null);
                      setImportState({ status: "idle" });
                      if (fileInputRef.current) {
                        fileInputRef.current.value = "";
                      }
                    }}
                    className="px-4 py-2 rounded-lg text-gray-600 hover:text-gray-800 hover:bg-gray-200 transition"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )
            : (
              <div>
                <p className="text-gray-600 mb-3">
                  Drag and drop a bookmark file here, or
                </p>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="px-6 py-2 rounded-lg font-bold text-white shadow hover:shadow-md transition"
                  style={{ backgroundColor: "var(--coral)" }}
                >
                  Choose File
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".html,.htm,.json,.csv,.txt"
                  className="hidden"
                  onChange={(e) =>
                    handleFileSelect(e.target.files?.[0] || null)}
                />
              </div>
            )}
        </div>

        {/* Progress bar during background processing */}
        {importState.status === "processing" && (
          <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <p className="text-blue-800 font-medium mb-2">
              Importing... {importState.progress.imported}/
              {importState.progress.total - importState.progress.skipped}{" "}
              bookmarks
            </p>
            <div className="w-full bg-blue-200 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all duration-500"
                style={{ width: `${importState.progress.progress}%` }}
              />
            </div>
            {importState.progress.skipped > 0 && (
              <p className="text-xs text-blue-600 mt-1">
                {importState.progress.skipped} duplicates skipped
              </p>
            )}
          </div>
        )}

        {/* Import result */}
        {importState.status === "complete" && importState.result && (
          <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-lg">
            <p className="text-green-800 font-medium">
              Import complete ({importState.result.format} format)
            </p>
            <ul className="text-sm text-green-700 mt-1 space-y-0.5">
              <li>{importState.result.imported} imported</li>
              {importState.result.skipped > 0 && (
                <li>{importState.result.skipped} skipped (duplicates)</li>
              )}
              {importState.result.failed > 0 && (
                <li>{importState.result.failed} failed</li>
              )}
            </ul>
          </div>
        )}

        {/* Import error */}
        {importState.status === "error" && (
          <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-red-800 font-medium">Import failed</p>
            <p className="text-sm text-red-700 mt-1">
              {importState.message}
            </p>
          </div>
        )}
      </section>

      {/* Supported formats */}
      <section className="bg-white rounded-lg shadow-md p-6">
        <h3 className="text-lg font-bold text-gray-800 mb-3">
          Supported Formats
        </h3>
        <div className="space-y-3 text-sm text-gray-700">
          <div className="flex gap-3">
            <span className="font-medium text-gray-800 min-w-[120px]">
              Netscape HTML
            </span>
            <span>Chrome, Firefox, Safari bookmark exports</span>
          </div>
          <div className="flex gap-3">
            <span className="font-medium text-gray-800 min-w-[120px]">
              Pinboard JSON
            </span>
            <span>Pinboard export</span>
          </div>
          <div className="flex gap-3">
            <span className="font-medium text-gray-800 min-w-[120px]">
              Pocket CSV
            </span>
            <span>Pocket export</span>
          </div>
          <div className="flex gap-3">
            <span className="font-medium text-gray-800 min-w-[120px]">
              Instapaper CSV
            </span>
            <span>Instapaper export</span>
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-4">
          The format is auto-detected from the file content. Duplicate bookmarks
          (same URL) are automatically skipped.
        </p>
      </section>
    </div>
  );
}
