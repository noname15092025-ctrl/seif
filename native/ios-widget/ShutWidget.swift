// Виджет SHUT для главного экрана iPhone (WidgetKit).
// Три кнопки — Задачи, Календарь, Заметки. Виджет НЕ читает данные сейфа (они зашифрованы),
// он только открывает приложение ссылкой shut://… на нужном разделе.
// Как добавить в Xcode — см. SETUP-IOS.md, раздел «Виджет на главном экране».
import WidgetKit
import SwiftUI

struct ShutEntry: TimelineEntry { let date: Date }

struct ShutProvider: TimelineProvider {
    func placeholder(in context: Context) -> ShutEntry { ShutEntry(date: Date()) }
    func getSnapshot(in context: Context, completion: @escaping (ShutEntry) -> Void) { completion(ShutEntry(date: Date())) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<ShutEntry>) -> Void) {
        completion(Timeline(entries: [ShutEntry(date: Date())], policy: .never)) // содержимое не меняется
    }
}

private let lime = Color(red: 200/255, green: 226/255, blue: 122/255)
private let bg = Color(red: 26/255, green: 26/255, blue: 29/255)
private let tile = Color(red: 38/255, green: 38/255, blue: 42/255)

struct ShutButton: View {
    let title: String, icon: String, view: String
    var body: some View {
        Link(destination: URL(string: "shut://" + view)!) {
            VStack(spacing: 6) {
                Image(systemName: icon).font(.system(size: 20, weight: .semibold)).foregroundColor(lime)
                Text(title).font(.system(size: 12, weight: .medium)).foregroundColor(.white).lineLimit(1).minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(tile))
        }
    }
}

struct ShutWidgetView: View {
    // Только средний размер: в маленьком виджете iOS разрешает одно касание на весь виджет, а кнопок три
    var body: some View {
        HStack(spacing: 8) {
            ShutButton(title: "Задачи", icon: "checkmark.circle", view: "tasks")
            ShutButton(title: "Календарь", icon: "calendar", view: "calendar")
            ShutButton(title: "Заметки", icon: "note.text", view: "notes")
        }
        .padding(2)
        .widgetBackground(bg)
    }
}

extension View {
    // iOS 17 требует containerBackground; на iOS 14–16 — обычный фон
    @ViewBuilder func widgetBackground(_ color: Color) -> some View {
        if #available(iOSApplicationExtension 17.0, *) { containerBackground(color, for: .widget) }
        else { background(color) }
    }
}

@main
struct ShutWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "ShutWidget", provider: ShutProvider()) { _ in ShutWidgetView() }
            .configurationDisplayName("SHUT")
            .description("Задачи, календарь и заметки в одно касание")
            .supportedFamilies([.systemMedium])
    }
}
