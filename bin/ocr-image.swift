#!/usr/bin/swift
import Foundation
import Vision
import ImageIO

guard CommandLine.arguments.count == 2 else { fputs("Usage: ocr-image.swift <image>\n", stderr); exit(2) }
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fputs("Could not read image\n", stderr); exit(1) }
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
let handler = VNImageRequestHandler(cgImage: image, options: [:])
do {
  try handler.perform([request])
  let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
  print(text)
} catch { fputs("OCR failed: \(error)\n", stderr); exit(1) }
