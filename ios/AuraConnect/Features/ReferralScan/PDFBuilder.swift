import UIKit

/// Renders scanned pages into a single PDF, downscaling and JPEG-compressing each page
/// to keep uploads well under the 25 MB storage limit.
enum PDFBuilder {
    /// US Letter width in points; page height follows each image's aspect ratio.
    static let pageWidth: CGFloat = 612

    static func makePDF(from images: [UIImage], maxPixelDimension: CGFloat = 2000, jpegQuality: CGFloat = 0.6) -> Data {
        let defaultBounds = CGRect(x: 0, y: 0, width: pageWidth, height: 792)
        let renderer = UIGraphicsPDFRenderer(bounds: defaultBounds)
        return renderer.pdfData { context in
            for image in images {
                let page = compressed(image, maxPixelDimension: maxPixelDimension, quality: jpegQuality)
                let size = page.size
                let aspect = size.width > 0 ? size.height / size.width : 792 / pageWidth
                let bounds = CGRect(x: 0, y: 0, width: pageWidth, height: (pageWidth * aspect).rounded())
                context.beginPage(withBounds: bounds, pageInfo: [:])
                page.draw(in: bounds)
            }
        }
    }

    /// Downscales to `maxPixelDimension` on the long edge and round-trips through JPEG.
    static func compressed(_ image: UIImage, maxPixelDimension: CGFloat, quality: CGFloat) -> UIImage {
        let pixelWidth = image.size.width * image.scale
        let pixelHeight = image.size.height * image.scale
        let longEdge = max(pixelWidth, pixelHeight)
        let scale = longEdge > maxPixelDimension ? maxPixelDimension / longEdge : 1
        let targetSize = CGSize(width: (pixelWidth * scale).rounded(), height: (pixelHeight * scale).rounded())

        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let resized = UIGraphicsImageRenderer(size: targetSize, format: format).image { _ in
            UIColor.white.setFill()
            UIRectFill(CGRect(origin: .zero, size: targetSize))
            image.draw(in: CGRect(origin: .zero, size: targetSize))
        }
        guard let data = resized.jpegData(compressionQuality: quality), let jpeg = UIImage(data: data) else {
            return resized
        }
        return jpeg
    }
}
