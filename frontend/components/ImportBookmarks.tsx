import { useRef, useState } from "react";
import { useApp } from "../context/AppContext.tsx";
import { apiFetch, apiPost } from "../utils/api.ts";
import type {
  ImportPrepareResponse,
  ImportProcessResponse,
  ImportResult,
} from "../../shared/types.ts";

type ImportState =
  | { status: "idle" }
  | { status: "preparing" }
  | {
    status: "importing";
    jobId: string;
    toImport: number;
    totalChunks: number;
    format: string;
    skipped: number;
    imported: number;
    failed: number;
  }
  | { status: "complete"; result: ImportResult }
  | { status: "error"; message: string };

export function ImportBookmarks() {
  const [importState, setImportState] = useState<ImportState>({
    status: "idle",
  });
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { loadInitialData, isSupporter } = useApp();

  function handleFileSelect(file: File | null) {
    setSelectedFile(file);
    setImportState({ status: "idle" });
  }

  async function handleImport() {
    if (!selectedFile) return;

    setImportState({ status: "preparing" });

    try {
      const formData = new FormData();
      formData.append("file", selectedFile);

      // Step 1: Prepare — parse, dedup, create job
      const prepareRes = await apiFetch("/api/import", {
        method: "POST",
        body: formData,
      });
      const prepare: ImportPrepareResponse = await prepareRes.json();

      if (!prepareRes.ok || !prepare.success) {
        setImportState({
          status: "error",
          message: prepare.error || "Import failed",
        });
        return;
      }

      // If nothing to import (all dupes or empty), we're done
      if (prepare.result) {
        setImportState({ status: "complete", result: prepare.result });
        setSelectedFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
        await loadInitialData();
        return;
      }

      // Step 2: Process chunks in a loop
      const jobId = prepare.jobId!;
      const toImport = prepare.toImport!;
      const totalChunks = prepare.totalChunks!;
      const format = prepare.format!;
      const skipped = prepare.skipped!;

      setImportState({
        status: "importing",
        jobId,
        toImport,
        totalChunks,
        format,
        skipped,
        imported: 0,
        failed: 0,
      });

      let done = false;
      let lastResult: ImportResult | undefined;
      const maxIterations = totalChunks + 2;
      let iterations = 0;

      while (!done && iterations < maxIterations) {
        iterations++;
        const processRes = await apiPost(`/api/import/${jobId}/process`);
        const process: ImportProcessResponse = await processRes.json();

        if (!processRes.ok || !process.success) {
          setImportState({
            status: "error",
            message: process.error || "Import processing failed",
          });
          return;
        }

        setImportState((prev) => {
          if (prev.status !== "importing") return prev;
          return {
            ...prev,
            imported: process.totalImported ?? prev.imported,
            failed: process.totalFailed ?? prev.failed,
          };
        });

        if (process.done) {
          done = true;
          lastResult = process.result;
        }
      }

      if (!done) {
        setImportState({
          status: "error",
          message: "Import stalled — please try again",
        });
        return;
      }

      if (lastResult) {
        setImportState({ status: "complete", result: lastResult });
      }
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

  const isProcessing = importState.status === "preparing" ||
    importState.status === "importing";

  if (!isSupporter) {
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

        <section
          className="rounded-lg p-6 space-y-4"
          style={{
            backgroundColor: "var(--coral-50)",
            border: "1px solid var(--coral-200)",
          }}
        >
          <div className="flex items-center gap-2">
            <svg
              className="w-5 h-5"
              fill="currentColor"
              viewBox="0 0 24 24"
              style={{ color: "var(--coral)" }}
              aria-hidden
            >
              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
            </svg>
            <h3
              className="text-xl font-bold"
              style={{ color: "var(--coral-700)" }}
            >
              Supporter-only feature
            </h3>
          </div>
          <p style={{ color: "var(--coral-700)" }}>
            Import is available to kipclip supporters. Become a supporter to
            unlock bulk import from Pinboard, Raindrop, Pocket, and more.
          </p>
          <a
            href="/settings#supporter"
            className="inline-flex items-center gap-2 px-5 py-3 rounded-lg font-medium text-white hover:opacity-95"
            style={{ backgroundColor: "var(--coral)" }}
          >
            Learn about supporting kipclip
          </a>
        </section>
      </div>
    );
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

      <div className="space-y-3">
        <div
          className="p-3 rounded-lg flex items-start gap-2"
          style={{
            backgroundColor: "var(--coral-50)",
            border: "1px solid var(--coral-200)",
          }}
        >
          <svg
            className="w-4 h-4 mt-0.5 shrink-0"
            fill="currentColor"
            viewBox="0 0 24 24"
            style={{ color: "var(--coral)" }}
            aria-hidden
          >
            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
          </svg>
          <p className="text-sm" style={{ color: "var(--coral-700)" }}>
            Thanks for supporting kipclip!
          </p>
        </div>
        <div
          className="p-3 rounded-lg flex items-start gap-2"
          style={{
            backgroundColor: "var(--coral-50)",
            border: "1px solid var(--coral-200)",
          }}
        >
          <svg
            className="w-4 h-4 mt-0.5 shrink-0"
            style={{ color: "var(--coral)" }}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 16h-1v-4h-1m1-4h.01M12 2a10 10 0 100 20 10 10 0 000-20z"
            />
          </svg>
          <p className="text-sm" style={{ color: "var(--coral-700)" }}>
            Bookmarks on AT Protocol are public. Anything you import can be seen
            by anyone.{" "}
            <a
              href="/about#how-it-works"
              className="underline hover:opacity-80"
            >
              Learn how it works
            </a>.
          </p>
        </div>
      </div>

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
                    disabled={isProcessing}
                    className="px-6 py-2 rounded-lg font-bold text-white shadow hover:shadow-md transition disabled:opacity-50"
                    style={{ backgroundColor: "var(--coral)" }}
                  >
                    {isProcessing ? "Importing..." : "Import Bookmarks"}
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
                    disabled={isProcessing}
                    className="px-4 py-2 rounded-lg text-gray-600 hover:text-gray-800 hover:bg-gray-200 transition disabled:opacity-50"
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

        {/* Preparing state */}
        {importState.status === "preparing" && (
          <div
            className="mt-4 p-4 rounded-lg"
            style={{
              backgroundColor: "var(--coral-50)",
              border: "1px solid var(--coral-200)",
            }}
          >
            <p className="font-medium" style={{ color: "var(--coral-700)" }}>
              Preparing import...
            </p>
            <p className="text-sm mt-1" style={{ color: "var(--coral-700)" }}>
              Parsing file and checking for duplicates
            </p>
          </div>
        )}

        {/* Progress bar during importing */}
        {importState.status === "importing" && (
          <div
            className="mt-4 p-4 rounded-lg"
            style={{
              backgroundColor: "var(--coral-50)",
              border: "1px solid var(--coral-200)",
            }}
          >
            <div className="flex justify-between items-center mb-2">
              <p className="font-medium" style={{ color: "var(--coral-700)" }}>
                Importing bookmarks...
              </p>
              <p className="text-sm" style={{ color: "var(--coral-700)" }}>
                {importState.imported + importState.failed} /{" "}
                {importState.toImport}
              </p>
            </div>
            <div
              className="w-full rounded-full h-2.5"
              style={{ backgroundColor: "var(--coral-200)" }}
            >
              <div
                className="h-2.5 rounded-full transition-all duration-300"
                style={{
                  width: `${
                    Math.round(
                      ((importState.imported + importState.failed) /
                        importState.toImport) * 100,
                    )
                  }%`,
                  backgroundColor: "var(--coral)",
                }}
              />
            </div>
            <ul
              className="text-sm mt-2 space-y-0.5"
              style={{ color: "var(--coral-700)" }}
            >
              <li>{importState.imported} imported</li>
              {importState.skipped > 0 && (
                <li>{importState.skipped} skipped (duplicates)</li>
              )}
              {importState.failed > 0 && <li>{importState.failed} failed</li>}
            </ul>
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
