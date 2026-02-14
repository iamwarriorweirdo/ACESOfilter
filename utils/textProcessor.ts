
export const redactPII = (text: string): string => {
    if (!text) return "";
    
    // 1. Email Redaction
    let redacted = text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, "[EMAIL_HIDDEN]");

    // 2. Vietnam Phone Number Redaction (Basic Regex for 10 digits starting with 0)
    // Matches: 090 123 4567, 090-123-4567, 0901234567
    redacted = redacted.replace(/(?:\+84|0)(?:\s?-?\d{3}){3}/g, "[PHONE_HIDDEN]");

    // 3. Vietnam ID Card (CCCD/CMND - 9 or 12 digits)
    redacted = redacted.replace(/\b\d{9}\b|\b\d{12}\b/g, (match) => {
        // Simple check to avoid redacting legitimate non-ID numbers
        if (match.startsWith('0')) return "[ID_HIDDEN]"; 
        return match;
    });

    return redacted;
};

export const recursiveChunking = (text: string, chunkSize: number = 1000, chunkOverlap: number = 200): string[] => {
    if (!text) return [];
    
    const chunks: string[] = [];
    let startIndex = 0;

    while (startIndex < text.length) {
        let endIndex = startIndex + chunkSize;

        if (endIndex >= text.length) {
            chunks.push(text.slice(startIndex));
            break;
        }

        // Try to find a good break point (paragraph -> sentence -> space)
        let breakPoint = -1;
        
        // Priority 1: Newline (Paragraph)
        const lastNewLine = text.lastIndexOf('\n', endIndex);
        if (lastNewLine > startIndex + chunkSize * 0.5) {
            breakPoint = lastNewLine;
        } 
        // Priority 2: Sentence ending (.!?)
        else {
            const lastPunctuation = Math.max(
                text.lastIndexOf('. ', endIndex),
                text.lastIndexOf('! ', endIndex),
                text.lastIndexOf('? ', endIndex)
            );
            if (lastPunctuation > startIndex + chunkSize * 0.5) {
                breakPoint = lastPunctuation + 1; // Include the punctuation
            } 
            // Priority 3: Space
            else {
                const lastSpace = text.lastIndexOf(' ', endIndex);
                if (lastSpace > startIndex) {
                    breakPoint = lastSpace;
                }
            }
        }

        // If no good break point found, force break at limit
        if (breakPoint === -1) {
            breakPoint = endIndex;
        }

        chunks.push(text.slice(startIndex, breakPoint).trim());
        
        // Move start index, considering overlap
        startIndex = breakPoint - chunkOverlap;
        // Prevent infinite loop if overlap is too big relative to content
        if (startIndex >= breakPoint) startIndex = breakPoint;
    }

    return chunks.filter(c => c.length > 50); // Filter out tiny chunks
};
