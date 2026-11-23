import { T, useGT } from "gt-react";
import { CheckIcon, CopyIcon, DownloadIcon } from "lucide-react";
import { useRef, type ComponentProps } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { downloadTextFile } from "../../lib/downloadTextFile";
import {
  serializeTableElementToCsv,
  serializeTableElementToHtml,
  serializeTableElementToMarkdown,
  tableCsvFilename,
} from "../../markdown-clipboard";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { reportMarkdownActionFailure, type TableCopyFormat } from "./markdownActionFailure";

const TABLE_COPY_SERIALIZERS: Record<TableCopyFormat, (table: Element) => string> = {
  markdown: serializeTableElementToMarkdown,
  csv: serializeTableElementToCsv,
  html: serializeTableElementToHtml,
};

export function MarkdownTable({ children, ...props }: ComponentProps<"table">) {
  const gt = useGT();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { copyToClipboard, isCopied: copied } = useCopyToClipboard<TableCopyFormat>({
    timeout: 1200,
    onError: (cause, format) =>
      reportMarkdownActionFailure({ operation: "copy-table", format }, cause),
  });
  const copyLabel = copied ? gt("Copied") : gt("Copy table");

  const handleCopy = (format: TableCopyFormat) => {
    const table = containerRef.current?.querySelector("table");
    if (!table) return;
    const text = TABLE_COPY_SERIALIZERS[format](table);
    // Plain-text targets get the markup; rich targets (mail, docs, wikis) paste a real table.
    copyToClipboard(
      text,
      format,
      format === "html" ? { "text/html": `<meta charset="utf-8">${text}` } : undefined,
      { requireHtml: format === "html" },
    );
  };

  const handleDownloadCsv = () => {
    const table = containerRef.current?.querySelector("table");
    if (!table) return;
    const headerRow = table.tHead?.rows[0] ?? table.rows[0];
    const headers = [...(headerRow?.cells ?? [])].map((cell) => cell.textContent ?? "");
    try {
      // The BOM makes Excel read the file as UTF-8; Slack and Sheets ignore it.
      downloadTextFile(
        tableCsvFilename(headers),
        `\uFEFF${serializeTableElementToCsv(table)}\n`,
        "text/csv;charset=utf-8",
      );
    } catch (cause) {
      reportMarkdownActionFailure({ operation: "download-table", format: "csv" }, cause);
    }
  };

  return (
    <div ref={containerRef} className="chat-markdown-table-container">
      <ScrollArea radius="none" chainVerticalScroll scrollFade className="w-full max-w-full">
        <table {...props}>{children}</table>
      </ScrollArea>
      {/* Stays within the row's px-1: the chat lane clips sideways overflow. */}
      <div className="mt-0.5 -mx-1 flex items-center justify-end select-none">
        <div className="flex items-center">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost-muted"
                  size="icon-xs"
                  onClick={handleDownloadCsv}
                  aria-label={gt("Download CSV")}
                />
              }
            >
              <DownloadIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              <T>Download CSV</T>
            </TooltipPopup>
          </Tooltip>
          <Menu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost-muted"
                        size="icon-xs"
                        aria-label={copyLabel}
                      />
                    }
                  />
                }
              >
                {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
              </TooltipTrigger>
              <TooltipPopup side="top">{copyLabel}</TooltipPopup>
            </Tooltip>
            <MenuPopup align="end">
              <MenuItem onClick={() => handleCopy("markdown")}>
                <T>Copy as Markdown</T>
              </MenuItem>
              <MenuItem onClick={() => handleCopy("csv")}>
                <T>Copy as CSV</T>
              </MenuItem>
              <MenuItem onClick={() => handleCopy("html")}>
                <T>Copy as HTML</T>
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
    </div>
  );
}
