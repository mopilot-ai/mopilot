// A reply's prose run as one UITextView laid out like React Native's Text, so iOS selects a range in place (#4837).
import ExpoModulesCore
import UIKit

/// One run of prose: paragraphs, headings and list items as styled stretches of one attributed string. It lays out as React Native's
/// Text does (a fixed line height per run with the text centred in it, no insets, no padding, TextKit 1), reports the height it needs
/// for its width in the same pixel steps React Native uses, keeps a selection while text is appended, and hands link taps and its
/// own menu entries to JS.
final class MoPilotSelectableTextView: ExpoView, UITextViewDelegate {
  let onContentSize = EventDispatcher()
  let onLinkPress = EventDispatcher()
  let onMenuAction = EventDispatcher()
  /// The edit menu is about to appear on this view, and words in it were selected: JS learns the press was answered, so the app's own sheet stays shut (#5369).
  let onMenuShown = EventDispatcher()
  let onSelect = EventDispatcher()

  /// TextKit 1, as React Native's Text lays out with: since iOS 16 a UITextView defaults to TextKit 2, which sets fixed line heights
  /// differently (the spike measured it 8/9 of React Native's height at every size), so the old layout manager is asked for.
  private let textView: UITextView = {
    if #available(iOS 16.0, *) { return UITextView(usingTextLayoutManager: false) }
    return UITextView()
  }()
  private var reportedHeight: CGFloat = -1
  /// The runs as attributed before each paragraph's space is fitted to React Native's block height (see `fitParagraphs`): what a change is compared with.
  private var plain = NSAttributedString()

  /// Each run: `t` its text, and as strings `fs` size, `lh` line height, `col` and `bg` as #rrggbb, `b` `i` `c` `d` flags ("1": bold, italic,
  /// inline code, strikethrough), `u` a link's URL, `ps` the space after its paragraph, `hi` and `fh` the paragraph's head and first-line indents.
  var runs: [[String: String]] = [] { didSet { restyle() } }
  var serif: Bool = true { didSet { restyle() } }
  /// The app's own entries in the edit menu (`first`: ahead of the system's, as Ask is), and the same as VoiceOver actions on the text.
  var menuEntries: [[String: String]] = [] { didSet { textView.accessibilityCustomActions = actions() } }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    textView.isEditable = false
    textView.isSelectable = true
    textView.isScrollEnabled = false
    textView.backgroundColor = .clear
    textView.textContainerInset = .zero
    textView.textContainer.lineFragmentPadding = 0
    textView.dataDetectorTypes = []
    textView.adjustsFontForContentSizeCategory = false
    textView.linkTextAttributes = [:]
    textView.delegate = self
    addSubview(textView)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds
    reportHeight()
  }

  private static func color(_ hex: String?) -> UIColor? {
    guard let hex, hex.hasPrefix("#"), hex.count == 7, let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
    return UIColor(
      red: CGFloat((value >> 16) & 0xff) / 255,
      green: CGFloat((value >> 8) & 0xff) / 255,
      blue: CGFloat(value & 0xff) / 255,
      alpha: 1)
  }

  private static func number(_ text: String?, _ fallback: CGFloat) -> CGFloat {
    guard let text, let value = Double(text), value.isFinite else { return fallback }
    return CGFloat(value)
  }

  /// The run's font: the system face or its serif design at the run's size, semibold or italic when it says so, Menlo for inline code.
  private func font(_ run: [String: String], size: CGFloat) -> UIFont {
    if run["c"] == "1" {
      // inline code at the footnote size the React renderer gives it (the run carries it, scaled with the system text size)
      let code = Self.number(run["cs"], size * 0.8)
      return UIFont(name: "Menlo", size: code) ?? UIFont.monospacedSystemFont(ofSize: code, weight: .regular)
    }
    var base = UIFont.systemFont(ofSize: size, weight: run["b"] == "1" ? .semibold : .regular)
    if serif, let design = base.fontDescriptor.withDesign(.serif) { base = UIFont(descriptor: design, size: size) }
    if run["i"] == "1", let traits = base.fontDescriptor.withSymbolicTraits(base.fontDescriptor.symbolicTraits.union(.traitItalic)) {
      base = UIFont(descriptor: traits, size: size)
    }
    return base
  }

  private func attributed() -> NSAttributedString {
    let out = NSMutableAttributedString()
    for run in runs {
      // a size or leading that is not a positive number is the default, as UIKit traps on a font of no size
      let size = max(Self.number(run["fs"], 17), 1)
      let lineHeight = max(Self.number(run["lh"], 26), 1)
      let font = font(run, size: size)
      let paragraph = NSMutableParagraphStyle()
      paragraph.minimumLineHeight = lineHeight
      paragraph.maximumLineHeight = lineHeight
      paragraph.paragraphSpacing = Self.number(run["ps"], 0)
      if run["al"] == "c" { paragraph.alignment = .center } else if run["al"] == "r" { paragraph.alignment = .right }
      paragraph.headIndent = Self.number(run["hi"], 0)
      paragraph.firstLineHeadIndent = Self.number(run["fh"], 0)
      if paragraph.headIndent > 0 { paragraph.tabStops = [NSTextTab(textAlignment: .left, location: paragraph.headIndent)] }
      var attrs: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: Self.color(run["col"]) ?? UIColor.label,
        .paragraphStyle: paragraph,
        .baselineOffset: (lineHeight - font.lineHeight) / 2,
      ]
      if let background = Self.color(run["bg"]) { attrs[.backgroundColor] = background }
      if let url = run["u"], let link = URL(string: url) {
        attrs[.link] = link
        attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue
      }
      if run["d"] == "1" { attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
      out.append(NSAttributedString(string: run["t"] ?? "", attributes: attrs))
    }
    return out
  }

  /// A change that only appended at the end (a streamed token) is appended, so a selection and its handles survive; any other change
  /// replaces the text and keeps the selection where it still fits.
  private func restyle() {
    let next = attributed()
    let current = plain
    plain = next
    if next.length >= current.length, current.length > 0,
      next.attributedSubstring(from: NSRange(location: 0, length: current.length)).isEqual(to: current)
    {
      textView.textStorage.append(next.attributedSubstring(from: NSRange(location: current.length, length: next.length - current.length)))
    } else if !next.isEqual(to: current) {
      let range = textView.selectedRange
      textView.attributedText = next
      textView.selectedRange = NSRange(location: min(range.location, next.length), length: 0)
    }
    reportHeight(force: true)
  }

  /// The height React Native gives a block of text `height` tall: rounded up to a whole pixel, and a height that already is a whole number of
  /// pixels one pixel more (every block measured on a device, #5369), so a paragraph drawn here must be given the same.
  private static func blockHeight(_ height: CGFloat) -> CGFloat {
    let scale = UIScreen.main.scale
    let pixels = height * scale
    var whole = pixels.rounded(.up)
    if whole - pixels < 0.001 { whole += 1 }
    return whole / scale
  }

  /// Gives each block of text the space after it that makes it as tall as the React text block it replaces: its own space plus what React Native
  /// adds to its lines. A paragraph with no space after it continues into the next: JS split one block there only so a line of another height keeps
  /// its own leading (`splitAtHeights`), and React draws both as one Text. Returns what the last block needs (the space after it is not part of
  /// the height of the text). Only the spacing attribute is written, and only where it changes, so a selection is kept and a second pass changes nothing.
  private func fitParagraphs() -> CGFloat {
    let storage = textView.textStorage
    let layout = textView.layoutManager
    let text = storage.string as NSString
    var tail: CGFloat = 0
    var block: CGFloat = 0
    var changes: [(NSRange, NSParagraphStyle)] = []
    var at = 0
    while at < text.length {
      let range = text.paragraphRange(for: NSRange(location: at, length: 0))
      at = NSMaxRange(range)
      layout.enumerateLineFragments(forGlyphRange: layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil)) { _, used, _, _, _ in
        block += used.height
      }
      guard let base = plain.attribute(.paragraphStyle, at: range.location, effectiveRange: nil) as? NSParagraphStyle,
        let style = base.mutableCopy() as? NSMutableParagraphStyle
      else { continue }
      // no space after it and more text to come: the block goes on
      let continues = base.paragraphSpacing == 0 && at < text.length
      let extra = continues ? 0 : Self.blockHeight(block) - block
      if !continues { block = 0 }
      tail = extra
      style.paragraphSpacing = base.paragraphSpacing + extra
      let have = storage.attribute(.paragraphStyle, at: range.location, effectiveRange: nil) as? NSParagraphStyle
      if abs((have?.paragraphSpacing ?? -1) - style.paragraphSpacing) > 0.001 { changes.append((range, style)) }
    }
    guard !changes.isEmpty else { return tail }
    storage.beginEditing()
    for (range, style) in changes { storage.addAttribute(.paragraphStyle, value: style, range: range) }
    storage.endEditing()
    return tail
  }

  /// The height React Native's Text would take: the used rect of the layout with each paragraph as tall as its React block, rounded up to a whole pixel.
  private func reportHeight(force: Bool = false) {
    // before its runs arrive the view has no text to measure: its height then is not the text's
    guard bounds.width > 0, textView.textStorage.length > 0 else { return }
    let container = textView.textContainer
    container.size = CGSize(width: bounds.width, height: .greatestFiniteMagnitude)
    textView.layoutManager.ensureLayout(for: container)
    let tail = fitParagraphs()
    textView.layoutManager.ensureLayout(for: container)
    let used = textView.layoutManager.usedRect(for: container).height + tail
    let scale = UIScreen.main.scale
    let height = (used * scale - 0.001).rounded(.up) / scale
    guard force || abs(height - reportedHeight) > 0.01 else { return }
    reportedHeight = height
    onContentSize(["height": height, "width": bounds.width])
  }

  private func actions() -> [UIAccessibilityCustomAction] {
    menuEntries.compactMap { entry in
      // an entry that acts on the selected words has none to act on from VoiceOver's action list
      guard let id = entry["id"], let title = entry["title"], entry["selection"] != "1", entry["native"] == nil else { return nil }
      return UIAccessibilityCustomAction(name: title) { [weak self] _ in
        self?.onMenuAction(["id": id])
        return true
      }
    }
  }

  // MARK: UITextViewDelegate

  /// The system is presenting the edit menu on this view: a long press here was answered natively.
  @available(iOS 16.0, *)
  func textView(_ textView: UITextView, willPresentEditMenuWith animator: UIEditMenuInteractionAnimating) {
    onMenuShown(["shown": "1"])
  }

  /// Words were selected (a long press selects a word before its menu shows; a handle drag changes the range): the press is being answered, with or without a menu yet.
  func textViewDidChangeSelection(_ textView: UITextView) {
    if textView.selectedRange.length > 0 { onSelect(["length": textView.selectedRange.length]) }
  }

  /// A tap on a link opens it through JS (the same targets as the rest of the app), never through the system; a long press asks JS for the
  /// app's own link menu (Open, Copy link: `menu`), as a link in a reply that is still streaming does; a preview does nothing. The system's
  /// link menu is not shown.
  func textView(_ textView: UITextView, shouldInteractWith URL: URL, in characterRange: NSRange, interaction: UITextItemInteraction) -> Bool {
    if interaction == .invokeDefaultAction { onLinkPress(["url": URL.absoluteString]) }
    else if interaction == .presentActions { onLinkPress(["url": URL.absoluteString, "menu": "1"]) }
    return false
  }

  /// The edit menu as ChatGPT lays it out: the app's first entry (Ask), then the system's Copy, then the app's `near` entries (Select Cell), then the rest of the system's entries
  /// (Look Up, Translate, Share...) and the app's others (Start a side chat, Copy message) after them.
  @available(iOS 16.0, *)
  func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
    let own = menuEntries.compactMap { entry -> (place: String, action: UIAction)? in
      // an entry for VoiceOver alone (`vo`) is an action of the text, not a line of the menu
      guard let id = entry["id"], let title = entry["title"], entry["vo"] != "1" else { return nil }
      let selected = entry["selection"] == "1" ? textView.attributedText.attributedSubstring(from: range).string : nil
      // an entry that cannot act now (`off`) is shown greyed with the reason (`why`) under it, rather than left out or doing nothing
      let native = entry["native"]
      let action = UIAction(title: title, subtitle: entry["why"]) { [weak self] _ in
        // `selectAll`: Select Cell, done here; the app is told nothing
        if native == "selectAll" { self?.textView.selectAll(nil); return }
        self?.onMenuAction(selected.map { ["id": id, "text": $0] } ?? ["id": id])
      }
      if entry["off"] == "1" { action.attributes = .disabled }
      return (entry["first"] == "1" ? "first" : entry["near"] == "1" ? "near" : "after", action)
    }
    let (copy, rest) = Self.takeCopy(from: suggestedActions)
    let ahead: [UIMenuElement] = own.filter { $0.place == "first" }.map { $0.action }
    let near: [UIMenuElement] = own.filter { $0.place == "near" }.map { $0.action }
    let after: [UIMenuElement] = own.filter { $0.place == "after" }.map { $0.action }
    return UIMenu(children: ahead + (copy.map { [$0] } ?? []) + near + rest + after)
  }

  /// The system's Copy command wherever the edit menu keeps it (at the top, or inside its standard-edit group), and what is left.
  @available(iOS 16.0, *)
  private static func takeCopy(from elements: [UIMenuElement]) -> (UIMenuElement?, [UIMenuElement]) {
    var copy: UIMenuElement?
    func walk(_ list: [UIMenuElement]) -> [UIMenuElement] {
      list.compactMap { element in
        if copy == nil, let command = element as? UICommand, command.action == #selector(UIResponderStandardEditActions.copy(_:)) {
          copy = command
          return nil
        }
        if let menu = element as? UIMenu, menu.identifier == .standardEdit || menu.options.contains(.displayInline) {
          let kept = walk(menu.children)
          return kept.isEmpty ? nil : menu.replacingChildren(kept)
        }
        return element
      }
    }
    let rest = walk(elements)
    return (copy, rest)
  }
}
