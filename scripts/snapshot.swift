// Renders an HTML file to a PNG with macOS WebKit (no browser needed). Used by scripts/gen-screenshots.ts.
//   swift scripts/snapshot.swift <in.html> <out.png> <width> <height> [scale]
// The page is laid out at width × height CSS pixels and written at `scale` × that size (default 2).

import AppKit
import WebKit

let args = CommandLine.arguments
guard args.count >= 5, let width = Double(args[3]), let height = Double(args[4]) else {
  FileHandle.standardError.write("usage: snapshot.swift <in.html> <out.png> <width> <height> [scale]\n".data(using: .utf8)!)
  exit(2)
}
let input = URL(fileURLWithPath: args[1])
let output = URL(fileURLWithPath: args[2])
let scale = args.count > 5 ? Double(args[5]) ?? 2 : 2

final class Snapper: NSObject, WKNavigationDelegate {
  let view: WKWebView
  let width: Double, height: Double, scale: Double, output: URL
  init(width: Double, height: Double, scale: Double, output: URL) {
    (self.width, self.height, self.scale, self.output) = (width, height, scale, output)
    view = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: WKWebViewConfiguration())
    super.init()
    view.navigationDelegate = self
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    // Give data-URI images a moment to decode.
    let (width, height, scale, output) = (self.width, self.height, self.scale, self.output)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
      let config = WKSnapshotConfiguration()
      config.rect = NSRect(x: 0, y: 0, width: width, height: height)
      config.snapshotWidth = NSNumber(value: width * scale)
      webView.takeSnapshot(with: config) { image, error in
        guard let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else {
          FileHandle.standardError.write("snapshot failed: \(String(describing: error))\n".data(using: .utf8)!)
          exit(1)
        }
        // Write exactly width·scale × height·scale pixels, whatever the screen's backing scale.
        let px = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(width * scale), pixelsHigh: Int(height * scale),
                                  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        px.size = NSSize(width: width, height: height)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: px)
        NSGraphicsContext.current?.imageInterpolation = .high
        rep.draw(in: NSRect(x: 0, y: 0, width: width, height: height))
        NSGraphicsContext.restoreGraphicsState()
        try! px.representation(using: .png, properties: [:])!.write(to: output)
        exit(0)
      }
    }
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    FileHandle.standardError.write("load failed: \(error)\n".data(using: .utf8)!)
    exit(1)
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let snapper = Snapper(width: width, height: height, scale: scale, output: output)
// An off-screen window gives the web view a backing scale and a real layout pass.
let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: width, height: height), styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = snapper.view
window.orderBack(nil)
snapper.view.loadFileURL(input, allowingReadAccessTo: input.deletingLastPathComponent())
DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
  FileHandle.standardError.write("timed out\n".data(using: .utf8)!)
  exit(1)
}
app.run()
