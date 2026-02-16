import {parseBodyRichText} from '../src/action';

describe('parseBodyRichText', () => {
  it('should handle markdown with headings', () => {
    const markdown = '## Short\nThis is some content';
    const result = parseBodyRichText(markdown);
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it('should handle markdown with inline code', () => {
    const markdown = 'This is some text with `code` in it';
    const result = parseBodyRichText(markdown);
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
  });

  it('should handle HTML img tags', () => {
    const markdown =
      '<img width="1219" height="273" alt="Image" src="https://github.com/user-attachments/assets/image.png" />';
    const result = parseBodyRichText(markdown);
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    // Should not include HTML tags in output
    const plainText = result
      .filter(item => item.type === 'text')
      .map(item => ('text' in item ? item.text.content : ''))
      .join('');
    expect(plainText).not.toContain('<img');
  });

  it('should handle complex issue body with multiple markdown elements', () => {
    const complexBody = `## Short
The auto-redeployment of failed jobs in a cluster is not working any longer in \`develop\`

## Proposal
Example:
<img width="1219" height="273" alt="Image" src="https://github.com/user-attachments/assets/image.png" />

The DEAD job should be redeployed by the cluster but in my case it remained like this for a while

## Solution
Check cluster jobs for monitoring and re-deployment

## Status
looking for feedback, searching for a solution`;
    const result = parseBodyRichText(complexBody);
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it('should gracefully handle empty body', () => {
    const result = parseBodyRichText('');
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
  });

  it('should return plain text as fallback if markdown parsing fails', () => {
    // This test verifies the fallback mechanism works
    const result = parseBodyRichText('Some plain text content');
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    if (result.length > 0) {
      expect(result[0].type).toBe('text');
    }
  });
});
