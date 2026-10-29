import { Check, Copy } from "lucide";
import { DownloadIcon } from "lucide-react";
import { useRef, type ComponentProps } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { downloadTextFile } from "../../lib/downloadTextFile";
import {
  serializeTableElementToCsv,
  serializeTableElementToMarkdown,
  tableCsvFilename,
} from "../../markdown-clipboard";
import { MorphIcon } from "../MorphIcon";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { reportMarkdownActionFailure } from "./markdownActionFailure";

export function MarkdownTable({ children, ...props }: ComponentProps<"table">) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { copyToClipboard, isCopied: copied } = useCopyToClipboard<"markdown" | "csv">({
    timeout: 1200,
    onError: (cause, format) =>
      reportMarkdownActionFailure({ operation: "copy-table", format }, cause),
  });
  const copyLabel = copied ? "Copied" : "Copy table";

  const handleCopy = (format: "markdown" | "csv") => {
    const table = containerRef.current?.querySelector("table");
    if (!table) return;
    copyToClipboard(
      format === "markdown"
        ? serializeTableElementToMarkdown(table)
        : serializeTableElementToCsv(table),
      format,
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
                  aria-label="Download CSV"
                />
              }
            >
              <DownloadIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">Download CSV</TooltipPopup>
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
                <MorphIcon className="size-3" icon={copied ? Check : Copy} />
              </TooltipTrigger>
              <TooltipPopup side="top">{copyLabel}</TooltipPopup>
            </Tooltip>
            <MenuPopup align="end">
              <MenuItem onClick={() => handleCopy("markdown")}>Copy as Markdown</MenuItem>
              <MenuItem onClick={() => handleCopy("csv")}>Copy as CSV</MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
    </div>
  );
}
