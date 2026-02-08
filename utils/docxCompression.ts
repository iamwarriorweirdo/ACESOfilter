
import JSZip from 'jszip';

// Helper to resize image blob
const resizeImageBlob = async (blob: Blob, maxWidth: number = 1600, quality: number = 0.7): Promise<Blob> => {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(blob);

        img.onload = () => {
            URL.revokeObjectURL(url);
            let width = img.width;
            let height = img.height;

            // Calculate new dimensions
            if (width > maxWidth) {
                height = Math.round((height * maxWidth) / width);
                width = maxWidth;
            }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;

            const ctx = canvas.getContext('2d');
            if (!ctx) {
                resolve(blob); // Fallback: return original if canvas fails
                return;
            }

            ctx.drawImage(img, 0, 0, width, height);

            canvas.toBlob((newBlob) => {
                if (newBlob && newBlob.size < blob.size) {
                    resolve(newBlob);
                } else {
                    resolve(blob); // Return original if resize made it larger (unlikely) or failed
                }
            }, 'image/jpeg', quality);
        };

        img.onerror = () => {
            URL.revokeObjectURL(url);
            resolve(blob); // Return original if load fails
        };

        img.src = url;
    });
};

export const compressDocx = async (file: File): Promise<File> => {
    try {
        console.log(`[Compression] Starting compression for ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);

        const zip = new JSZip();
        // verify valid docx
        const loadedZip = await zip.loadAsync(file);

        const mediaFolder = loadedZip.folder("word/media");
        if (!mediaFolder) {
            console.log("[Compression] No media folder found, skipping.");
            return file;
        }

        const filesToProcess: { name: string, data: any }[] = [];

        // Find large images
        mediaFolder.forEach((relativePath, fileHandle) => {
            // roughly filter for images
            if (relativePath.match(/\.(jpg|jpeg|png)$/i)) {
                filesToProcess.push({ name: relativePath, data: fileHandle });
            }
        });

        let compressedCount = 0;
        let originalSizeTotal = 0;
        let newSizeTotal = 0;

        for (const item of filesToProcess) {
            const content = await item.data.async("blob");
            if (content.size > 500 * 1024) { // Only standard resize if > 500KB
                originalSizeTotal += content.size;
                const processedBlob = await resizeImageBlob(content);
                newSizeTotal += processedBlob.size;

                // Replace in zip
                mediaFolder.file(item.name, processedBlob);
                compressedCount++;
            }
        }

        if (compressedCount === 0) {
            console.log("[Compression] No large images found to compress.");
            return file;
        }

        console.log(`[Compression] Compressed ${compressedCount} images. Reduced media size from ${(originalSizeTotal / 1024 / 1024).toFixed(2)}MB to ${(newSizeTotal / 1024 / 1024).toFixed(2)}MB`);

        // Generate new file
        const newContent = await zip.generateAsync({
            type: "blob",
            compression: "DEFLATE",
            compressionOptions: { level: 6 } // Good balance
        });

        const newFile = new File([newContent], file.name, {
            type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            lastModified: Date.now()
        });

        console.log(`[Compression] Final file size: ${(newFile.size / 1024 / 1024).toFixed(2)} MB`);
        return newFile;

    } catch (e) {
        console.error("[Compression] Error:", e);
        return file; // Fail safe: return original
    }
};
