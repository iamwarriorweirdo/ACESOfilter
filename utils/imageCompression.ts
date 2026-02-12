
export const compressImage = async (file: File, quality = 0.7, maxWidth = 1920): Promise<File> => {
    // Chỉ nén các loại ảnh thông dụng
    if (!file.type.match(/image\/(jpeg|jpg|png|webp)/)) {
        return file;
    }

    return new Promise((resolve, reject) => {
        const image = new Image();
        image.src = URL.createObjectURL(file);
        
        image.onload = () => {
            URL.revokeObjectURL(image.src);
            let width = image.width;
            let height = image.height;

            // Giữ tỷ lệ khung hình và resize nếu ảnh quá lớn
            if (width > maxWidth) {
                height = Math.round((height * maxWidth) / width);
                width = maxWidth;
            }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;

            const ctx = canvas.getContext('2d');
            if (!ctx) {
                resolve(file); // Fallback nếu lỗi canvas
                return;
            }

            ctx.drawImage(image, 0, 0, width, height);

            // Chuyển đổi sang Blob (mặc định là JPEG để tối ưu dung lượng nhất)
            canvas.toBlob(
                (blob) => {
                    if (blob) {
                        // Nếu file nén lại nặng hơn file gốc (hiếm gặp), dùng file gốc
                        if (blob.size > file.size) {
                            resolve(file);
                        } else {
                            const newFile = new File([blob], file.name, {
                                type: 'image/jpeg',
                                lastModified: Date.now(),
                            });
                            console.log(`[Image Compression] ${file.name}: ${(file.size/1024/1024).toFixed(2)}MB -> ${(newFile.size/1024/1024).toFixed(2)}MB`);
                            resolve(newFile);
                        }
                    } else {
                        resolve(file);
                    }
                },
                'image/jpeg',
                quality
            );
        };

        image.onerror = (error) => reject(error);
    });
};
