/**
 * report-generator.js - Text Report Generation Module
 *
 * Converts RENDERED UI DOM to readable text report with tooltips.
 * Strategy: Read from actual DOM elements that are already rendered.
 * Only runs when user clicks Export button (lazy generation).
 *
 * Contains:
 * - generateTextReport(): Main entry point - reads from DOM
 * - Section extractors: Read from rendered HTML sections
 */


// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract tooltip from DOM element
 * @param {HTMLElement} element - DOM element
 * @returns {string|null} Tooltip text or null
 */
function getTooltip(element) {
  if (!element) return null;

  const tooltip = element.getAttribute('data-tooltip');
  if (tooltip) return tooltip;

  // Check for child elements with tooltip
  const tooltipEl = element.querySelector('[data-tooltip]');
  return tooltipEl ? tooltipEl.getAttribute('data-tooltip') : null;
}

/**
 * Get text content from element, stripping extra whitespace
 * @param {HTMLElement} element - DOM element
 * @returns {string} Cleaned text content
 */
function getCleanText(element) {
  if (!element) return '';
  return element.textContent.trim().replace(/\s+/g, ' ');
}

/**
 * Create section separator line
 * @param {string} title - Section title
 * @returns {string} Formatted section header
 */
function sectionHeader(title) {
  const line = '-'.repeat(70);
  return `\n${line}\n${title}\n${line}`;
}

/**
 * Format table row (from DOM tr element)
 * @param {HTMLTableRowElement} row - Table row element
 * @param {number} indent - Indentation level
 * @returns {string} Formatted line (tooltip inline)
 */
function formatTableRow(row, indent = 0) {
  const prefix = '  '.repeat(indent);
  const cells = row.querySelectorAll('td');

  if (cells.length < 2) return '';

  const label = getCleanText(cells[0]);
  const valueCell = cells[1];
  const value = getCleanText(valueCell);
  const tooltip = getTooltip(valueCell);

  // Tooltip on same line with arrow
  let result = `${prefix}${label}: ${value}`;
  if (tooltip) {
    result += ` -> ${tooltip}`;
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION EXTRACTORS (Read from DOM)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract WebRTC section from rendered DOM
 * @returns {string} Formatted text
 */
function extractRTCSection() {
  const container = document.getElementById('rtcContent');
  if (!container) return '';

  const noData = container.querySelector('.no-data');
  if (noData) {
    return sectionHeader('WEBRTC STATISTICS') + '\n' + getCleanText(noData) + '\n';
  }

  let output = sectionHeader('WEBRTC STATISTICS');

  // Extract both columns
  const columns = container.querySelectorAll('.rtc-column');

  columns.forEach((column) => {
    const subHeader = column.querySelector('.sub-header-title');
    if (subHeader) {
      output += `\n\n${getCleanText(subHeader)}`;
    }

    const table = column.querySelector('table');
    if (table) {
      const rows = table.querySelectorAll('tr');
      rows.forEach(row => {
        const formatted = formatTableRow(row, 1);
        if (formatted) output += '\n' + formatted;
      });
    }
  });

  return output + '\n';
}

/**
 * Extract getUserMedia section from rendered DOM
 * @returns {string} Formatted text
 */
function extractGUMSection() {
  const container = document.getElementById('gumContent');
  if (!container) return '';

  const noData = container.querySelector('.no-data');
  if (noData) {
    return sectionHeader('GETUSERMEDIA (USER MEDIA)') + '\n' + getCleanText(noData) + '\n';
  }

  let output = sectionHeader('GETUSERMEDIA (USER MEDIA)');

  const table = container.querySelector('table');
  if (table) {
    const rows = table.querySelectorAll('tr');
    rows.forEach(row => {
      const formatted = formatTableRow(row, 1);
      if (formatted) output += '\n' + formatted;
    });
  }

  return output + '\n';
}

/**
 * Extract AudioContext section from rendered DOM (with tree)
 * @returns {string} Formatted text
 */
function extractACSection() {
  const container = document.getElementById('acContent');
  if (!container) return '';

  const noData = container.querySelector('.no-data');
  if (noData) {
    return sectionHeader('AUDIOCONTEXT ANALYSIS') + '\n' + getCleanText(noData) + '\n';
  }

  let output = sectionHeader('AUDIOCONTEXT ANALYSIS');

  // Extract each context item
  const contextItems = container.querySelectorAll('.context-item');

  contextItems.forEach((item, idx) => {
    if (idx > 0) output += '\n';

    output += '\n\n';

    // Purpose label
    const purpose = item.querySelector('.context-purpose');
    if (purpose) {
      output += getCleanText(purpose);
      const tooltip = getTooltip(item);
      if (tooltip) {
        output += ` -> ${tooltip}`;
      }
    }

    // Table rows
    const table = item.querySelector('table');
    if (table) {
      const rows = table.querySelectorAll('tr');
      rows.forEach(row => {
        const formatted = formatTableRow(row, 1);
        if (formatted) output += '\n' + formatted;
      });
    }

    // Audio Path Flow
    const flowContainer = item.querySelector('.audio-flow');
    if (flowContainer) {
      output += '\n\n  Audio Path Flow:';
      const flowText = extractFlowFromDOM(flowContainer);
      output += '\n' + flowText;
    }
  });

  return output + '\n';
}

/**
 * Extract flow structure from rendered DOM flow
 * @param {HTMLElement} flowContainer - .audio-flow container
 * @returns {string} ASCII flow with tooltips (inline)
 */
function extractFlowFromDOM(flowContainer) {
  if (!flowContainer) return '    (No flow)';

  function processNode(nodeEl, isLast = false, prefix = '') {
    const labelEl = nodeEl.querySelector(':scope > .flow-label');
    if (!labelEl) return '';

    const labelText = getCleanText(labelEl);
    const tooltip = getTooltip(labelEl);

    // Flow characters - use simple ASCII for consistent width
    const connector = isLast ? '+-- ' : '|-- ';
    const childPrefix = prefix + (isLast ? '    ' : '|   ');

    // Tooltip on same line with arrow
    let result = prefix + connector + labelText;
    if (tooltip) {
      result += ' -> ' + tooltip;
    }

    // Process outputs (downstream nodes)
    const outputsContainer = nodeEl.querySelector(':scope > .flow-outputs');
    if (outputsContainer) {
      const outputNodes = outputsContainer.querySelectorAll(':scope > .flow-node');
      outputNodes.forEach((outputNode, idx) => {
        const outputIsLast = idx === outputNodes.length - 1;
        result += '\n' + processNode(outputNode, outputIsLast, childPrefix);
      });
    }

    return result;
  }

  const rootNode = flowContainer.querySelector(':scope > .flow-node');
  if (!rootNode) return '    (No root node)';

  const flowText = processNode(rootNode, true, '    ');
  return flowText;
}


/**
 * Extract Encoding section from rendered DOM
 * @returns {string} Formatted text
 */
function extractEncodingSection() {
  const container = document.getElementById('encodingContent');
  if (!container) return '';

  const noData = container.querySelector('.no-data');
  if (noData) {
    return sectionHeader('ENCODING DETECTION') + '\n' + getCleanText(noData) + '\n';
  }

  let output = sectionHeader('ENCODING DETECTION');

  const table = container.querySelector('table');
  if (table) {
    const rows = table.querySelectorAll('tr');
    rows.forEach(row => {
      const formatted = formatTableRow(row, 1);
      if (formatted) output += '\n' + formatted;
    });
  }

  return output + '\n';
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN EXPORT FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate complete text report from RENDERED UI DOM
 * Only runs when user clicks Export button (lazy generation)
 * Reads from actual DOM elements that are already rendered in popup
 * @returns {string} Complete text report
 */
export function generateTextReport() {
  const lines = [];

  // Header
  lines.push('='.repeat(70));
  lines.push('  AudioInspector - Analysis Report');
  lines.push('='.repeat(70));

  // Metadata
  lines.push('');
  lines.push(`Report Generated: ${new Date().toLocaleString('en-US')}`);
  lines.push('');

  // Extract all sections from rendered DOM
  const rtcSection = extractRTCSection();
  if (rtcSection) lines.push(rtcSection);

  const gumSection = extractGUMSection();
  if (gumSection) lines.push(gumSection);

  const acSection = extractACSection();
  if (acSection) lines.push(acSection);

  const encodingSection = extractEncodingSection();
  if (encodingSection) lines.push(encodingSection);

  // Footer
  lines.push('\n' + '='.repeat(70));
  lines.push('End of Report');
  lines.push('='.repeat(70));

  return lines.join('\n');
}
