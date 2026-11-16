import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import DOMPurify from 'dompurify';

interface EmailBodyViewerProps {
  htmlContent: string;
  className?: string;
}

export function EmailBodyViewer({ htmlContent, className = '' }: EmailBodyViewerProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeHeight, setIframeHeight] = useState(250);

  const fullHTML = useMemo(() => {
    if (!htmlContent || htmlContent.trim() === '') return '';

    // Decode HTML entities to fix encoding issues
    const decodeHTML = (html: string): string => {
      const textarea = document.createElement('textarea');
      textarea.innerHTML = html;
      return textarea.value;
    };

    const decodedHTML = decodeHTML(htmlContent);

    let processedHTML = decodedHTML;

    processedHTML = processedHTML.replace(
      /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
      (match, content) => {
        const id = Math.random().toString(36).substr(2, 9);
        return `<div class="quoted-section" data-quote-id="${id}">
          <div class="quoted-toggle">
            <span class="toggle-icon">...</span>
          </div>
          <blockquote class="quoted-content" id="quote-${id}" style="display: none;">${content}</blockquote>
        </div>`;
      }
    );

    const sanitizedHTML = DOMPurify.sanitize(processedHTML, {
      ALLOWED_TAGS: [
        'html', 'head', 'body', 'meta', 'title', 'style',
        'p', 'br', 'div', 'span', 'a', 'img',
        'strong', 'em', 'u', 'b', 'i', 's', 'strike',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'ul', 'ol', 'li',
        'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
        'font', 'center', 'blockquote', 'pre', 'code',
        'hr', 'sup', 'sub'
      ],
      ALLOWED_ATTR: [
        'style', 'class', 'id',
        'href', 'target', 'rel',
        'src', 'alt', 'title', 'width', 'height',
        'align', 'valign',
        'border', 'cellpadding', 'cellspacing',
        'bgcolor', 'color', 'face', 'size',
        'data-quote-id'
      ],
      ALLOW_DATA_ATTR: true,
      ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|cid|xmpp|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    });

    const emailStyles = `
      <style>
        * {
          box-sizing: border-box;
        }
        body {
          font-family: Arial, sans-serif;
          font-size: 14px;
          line-height: 1.6;
          color: #202124;
          margin: 0;
          padding: 16px;
          background: white;
          overflow-x: hidden;
          word-wrap: break-word;
        }

        /* Table styling - Gmail style */
        table {
          border-collapse: collapse !important;
          width: auto !important;
          max-width: 100%;
          margin: 12px 0;
          font-size: 13px;
        }

        table, th, td {
          border: 1px solid #000 !important;
        }

        th, td {
          padding: 6px 10px !important;
          text-align: left;
          vertical-align: top;
          word-break: break-word;
        }

        th {
          font-weight: 700 !important;
        }

        /* Preserve inline styles and colors */
        th[bgcolor], td[bgcolor] {
          /* Browser will apply bgcolor attribute */
        }

        /* Common email table colors */
        [bgcolor="#FFFF00"], [bgcolor="yellow"], [style*="background:yellow"], [style*="background-color:yellow"] {
          background-color: #FFFF00 !important;
        }

        [bgcolor="#E6E6FA"], [bgcolor="lavender"], [style*="background:lavender"], [style*="background-color:lavender"] {
          background-color: #E6E6FA !important;
        }

        [style*="color:blue"], [style*="color:#0000FF"] {
          color: #0000FF !important;
        }

        [style*="color:darkblue"], [style*="color:#00008B"] {
          color: #00008B !important;
        }

        /* Typography */
        p {
          margin: 8px 0;
        }

        p:first-child {
          margin-top: 0;
        }

        p:last-child {
          margin-bottom: 0;
        }

        a {
          color: #1a73e8;
          text-decoration: underline;
        }

        a:hover {
          text-decoration: underline;
        }

        strong, b {
          font-weight: 700;
        }

        em, i {
          font-style: italic;
        }

        /* Lists */
        ul, ol {
          margin: 8px 0;
          padding-left: 24px;
        }

        li {
          margin: 4px 0;
        }

        /* Blockquotes */
        blockquote {
          margin: 8px 0;
          padding-left: 16px;
          border-left: 4px solid #ccc;
          color: #666;
        }

        /* Quoted sections (collapsed by default) */
        .quoted-section {
          margin: 8px 0;
        }

        .quoted-toggle {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 2px 8px;
          background: #f1f3f4;
          border: 1px solid #dadce0;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
          color: #5f6368;
          user-select: none;
        }

        .quoted-toggle:hover {
          background: #e8eaed;
        }

        .toggle-icon {
          display: inline-block;
          font-weight: bold;
        }

        .quoted-content {
          margin: 8px 0 8px 16px;
          padding-left: 12px;
          border-left: 2px solid #dadce0;
          color: #5f6368;
        }

        /* Headers */
        h1, h2, h3, h4, h5, h6 {
          margin: 12px 0 8px 0;
          font-weight: 700;
          line-height: 1.3;
        }

        /* Images */
        img {
          max-width: 100%;
          height: auto;
        }

        /* Horizontal rules */
        hr {
          border: none;
          border-top: 1px solid #dadce0;
          margin: 16px 0;
        }

        /* Prevent overflow */
        pre {
          white-space: pre-wrap;
          word-wrap: break-word;
          overflow-x: auto;
        }

        /* Center tag support */
        center {
          text-align: center;
        }
      </style>
    `;

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          ${emailStyles}
          <script>
            document.addEventListener('click', function(e) {
              const toggle = e.target && e.target.closest ? e.target.closest('.quoted-toggle') : null;
              if (toggle) {
                const parent = toggle.closest('.quoted-section');
                const quoteId = parent ? parent.getAttribute('data-quote-id') : null;
                if (quoteId) {
                  const content = document.getElementById('quote-' + quoteId);
                  const icon = toggle.querySelector('.toggle-icon');
                  if (content) {
                    if (content.style.display === 'none') {
                      content.style.display = 'block';
                      if (icon) icon.textContent = '▼';
                    } else {
                      content.style.display = 'none';
                      if (icon) icon.textContent = '...';
                    }
                  }
                }
              }
            });
          </script>
        </head>
        <body>
          ${sanitizedHTML}
        </body>
      </html>
    `;
  }, [htmlContent]);

  const measureHeight = useCallback(() => {
    try {
      const iframe = iframeRef.current;
      if (!iframe) return;
      const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!iframeDoc) return;
      const body = iframeDoc.body;
      const html = iframeDoc.documentElement;
      const height = Math.max(
        body?.scrollHeight || 0,
        body?.offsetHeight || 0,
        html?.clientHeight || 0,
        html?.scrollHeight || 0,
        html?.offsetHeight || 0
      );
      if (height > 0) {
        setIframeHeight(Math.max(height + 20, 100));
      }
    } catch {
      // Ignore cross-origin access errors in sandboxed context
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(measureHeight, 150);
    return () => clearTimeout(timer);
  }, [fullHTML, measureHeight]);

  if (!htmlContent || htmlContent.trim() === '') {
    return (
      <div className={`text-gray-500 italic p-4 ${className}`}>
        No email content available
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      title="Email Content"
      srcDoc={fullHTML}
      onLoad={measureHeight}
      className={`w-full border-0 ${className}`}
      style={{
        height: `${iframeHeight}px`,
        minHeight: '100px',
        maxHeight: '800px',
      }}
      sandbox="allow-scripts allow-popups"
      loading="lazy"
    />
  );
}
