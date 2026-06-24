import React from "react";
import { ExternalLink, Copy } from "lucide-react";
import type { ProjectLink } from "../../../shared/protocol";

function openUrl(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

function humanize(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

interface ProjectLinkButtonsProps {
  links: ProjectLink[];
  className?: string;
}

// PROJECT.md frontmatter entries as header buttons: URL values (notion, linear)
// open externally; non-URL values (e.g. "local repo") copy to the clipboard.
const ProjectLinkButtons: React.FC<ProjectLinkButtonsProps> = ({ links, className }) => {
  if (links.length === 0) return null;
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className ?? ""}`}>
      {links.map((link) =>
        link.isUrl ? (
          <button
            key={link.key}
            className="btn btn-sm btn-accent btn-soft"
            title={link.value}
            onClick={() => openUrl(link.value)}
          >
            <ExternalLink size={14} /> {humanize(link.key)}
          </button>
        ) : (
          <button
            key={link.key}
            className="btn btn-sm btn-outline btn-neutral font-normal"
            title={`Copy: ${link.value}`}
            onClick={() =>
              navigator.clipboard.writeText(link.value).catch((err) => console.error("Failed to copy:", err))
            }
          >
            <Copy size={14} /> {humanize(link.key)}
          </button>
        )
      )}
    </div>
  );
};

export default ProjectLinkButtons;
