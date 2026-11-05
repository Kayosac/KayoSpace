/** Иконки интерфейса: простые линии 24×24, цвет — currentColor. */

import type { ReactNode } from 'react';

const Svg = ({ children }: { children: ReactNode }) => (
  <svg
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const PenIcon = () => (
  <Svg>
    <path d="M4 20l1.2-4.6L15.6 5a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8 4 20z" />
    <path d="M13.8 6.8l3.4 3.4" />
  </Svg>
);

export const EraserIcon = () => (
  <Svg>
    <path d="M8.5 19.5l-4-4a1.8 1.8 0 0 1 0-2.6l8.4-8.4a1.8 1.8 0 0 1 2.6 0l4 4a1.8 1.8 0 0 1 0 2.6l-7.4 7.4" />
    <path d="M8.5 19.5h11M7 11l6 6" />
  </Svg>
);

export const HandIcon = () => (
  <Svg>
    <path d="M8 11V5.5a1.5 1.5 0 0 1 3 0V10" />
    <path d="M11 9.5V4.5a1.5 1.5 0 0 1 3 0V10" />
    <path d="M14 10V6a1.5 1.5 0 0 1 3 0v6.5" />
    <path d="M8 11a1.5 1.5 0 0 0-3 0v2.5a7 7 0 0 0 7 7h.5a5.5 5.5 0 0 0 5.5-5.5V12a1.5 1.5 0 0 0-3 0" />
  </Svg>
);

export const UndoIcon = () => (
  <Svg>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Svg>
);

export const RedoIcon = () => (
  <Svg>
    <path d="M15 14l5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
  </Svg>
);

export const MinusIcon = () => (
  <Svg>
    <path d="M6 12h12" />
  </Svg>
);

export const PlusIcon = () => (
  <Svg>
    <path d="M12 6v12M6 12h12" />
  </Svg>
);

export const FitIcon = () => (
  <Svg>
    <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />
  </Svg>
);

export const SettingsIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Svg>
);

export const CloseIcon = () => (
  <Svg>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const SelectIcon = () => (
  <Svg>
    <path d="M5 4l13.5 6.2-5.6 1.9-1.9 5.6L5 4z" />
    <path d="M13 13l5.5 5.5" />
  </Svg>
);

export const DuplicateIcon = () => (
  <Svg>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </Svg>
);

export const CopyIcon = () => (
  <Svg>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a1 1 0 0 1 1-1h10" />
  </Svg>
);

export const PasteIcon = () => (
  <Svg>
    <path d="M9 4h6v3H9z" />
    <path d="M15 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2" />
  </Svg>
);

export const TrashIcon = () => (
  <Svg>
    <path d="M4 7h16M10 11v6M14 11v6" />
    <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </Svg>
);

export const StickyIcon = () => (
  <Svg>
    <path d="M5 4h14a1 1 0 0 1 1 1v9l-6 6H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
    <path d="M14 20v-5a1 1 0 0 1 1-1h5" />
  </Svg>
);

export const TextIcon = () => (
  <Svg>
    <path d="M5 6V4h14v2M12 4v16M9 20h6" />
  </Svg>
);

export const ShapesIcon = () => (
  <Svg>
    <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
    <circle cx="16" cy="16" r="4.5" />
  </Svg>
);

export const RectIcon = () => (
  <Svg>
    <rect x="4" y="6" width="16" height="12" rx="2" />
  </Svg>
);

export const EllipseIcon = () => (
  <Svg>
    <ellipse cx="12" cy="12" rx="8.5" ry="6.5" />
  </Svg>
);

export const LineIcon = () => (
  <Svg>
    <path d="M5 19L19 5" />
  </Svg>
);

export const ArrowIcon = () => (
  <Svg>
    <path d="M5 19L18 6M10 6h8v8" />
  </Svg>
);

export const BoardsIcon = () => (
  <Svg>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" />
  </Svg>
);

export const SearchIcon = () => (
  <Svg>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4 4" />
  </Svg>
);

export const CompassIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 5.5l2.2 6.5h-4.4z" fill="currentColor" stroke="none" />
    <path d="M12 18.5l-2.2-6.5h4.4z" />
  </Svg>
);

export const ImageIcon = () => (
  <Svg>
    <rect x="3.5" y="5" width="17" height="14" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M4 17l5-5 4 4 2.5-2.5L20 18" />
  </Svg>
);

export const SparkleIcon = () => (
  <Svg>
    <path d="M12 3.5l1.9 5.1a2 2 0 0 0 1.2 1.2l5.1 1.9-5.1 1.9a2 2 0 0 0-1.2 1.2L12 19.9l-1.9-5.1a2 2 0 0 0-1.2-1.2L3.8 11.7l5.1-1.9a2 2 0 0 0 1.2-1.2z" />
    <path d="M19 3v3M17.5 4.5h3" />
  </Svg>
);

export const ScanIcon = () => (
  <Svg>
    <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
    <path d="M4 12h16" />
  </Svg>
);

export const FrameIcon = () => (
  <Svg>
    <path d="M7 3v18M17 3v18M3 7h18M3 17h18" />
  </Svg>
);

export const HighlighterIcon = () => (
  <Svg>
    <path d="M9 14l-2 2v3h3l2-2" />
    <path d="M9 14l6-10 5 5-10 6z" />
    <path d="M3 21h8" />
  </Svg>
);

export const MoreIcon = () => (
  <Svg>
    <circle cx="5.5" cy="12" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="18.5" cy="12" r="1" />
  </Svg>
);

export const MapIcon = () => (
  <Svg>
    <rect x="3.5" y="5" width="17" height="14" rx="2" />
    <rect x="12" y="11" width="6" height="5" rx="1" />
  </Svg>
);

export const ExportIcon = () => (
  <Svg>
    <path d="M12 15V4M8 8l4-4 4 4" />
    <path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
  </Svg>
);

export const PlayIcon = () => (
  <Svg>
    <path d="M8 5.5v13l10.5-6.5z" />
  </Svg>
);

export const ChevronLeftIcon = () => (
  <Svg>
    <path d="M15 5l-7 7 7 7" />
  </Svg>
);

export const ChevronRightIcon = () => (
  <Svg>
    <path d="M9 5l7 7-7 7" />
  </Svg>
);

export const PdfIcon = () => (
  <Svg>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
    <path d="M9 13h6M9 17h4" />
  </Svg>
);
