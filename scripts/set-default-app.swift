// 读写 `.md` 的**默认打开应用**（`design/0015` §2.4 / `INV-APP-04`）。
//
// # 为什么是 Swift 而不是 osascript
//
// LaunchServices 的「默认应用」在 macOS 12+ 才有公开 API：
// `NSWorkspace.setDefaultApplication(at:toOpenContentTypeOfFileAtURL:)`。
// 它**没有** AppleScript 的等价物（`duti` 也没装），而本机自带 swift。
//
// # 两种模式，⛔ 绝不混用
//
//   --show <样本.md>            只读：问"现在谁是这个类型的主人"，**不改任何东西**
//   --set <目标.app> <样本.md>  写：设置默认应用，然后**读回来核对**
//
// ⚠️ 判据用**样本文件**而不是 UTI 字符串，是因为 LaunchServices 的
//    `setDefaultApplication(at:toOpenContentTypeOfFileAtURL:)` 要的是"一个该类型的文件"。
//    直接把 `.md` 交进去，系统自己解析 UTI（本机实测 = `net.daringfireball.markdown`），
//    ⛔ 我们**不硬编码 UTI**：用户机器上的 `.md` 归属可能被别的应用改写过。
//
// ⚠️ `--set` 是**系统级设置**（`INV-APP-04`）：只有人显式跑 `make default-app` 才允许调它，
//    ⛔ `make app` / `make install-app` / `make smoke-app` 一次都不许碰（那条不变量由 Makefile 守）。
//
// 退出码：0 = 成功且核对通过；1 = 参数/环境错误；2 = 设置后读回来的**不是**目标应用。

import AppKit
import Foundation

func die(_ message: String, _ code: Int32 = 1) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

/// 返回"这个样本文件当前由谁打开"的应用 URL（可能为 nil）。
func currentApp(for sample: URL) -> URL? {
    NSWorkspace.shared.urlForApplication(toOpen: sample)
}

/// 只读查询：把当前默认应用打出来。⛔ 不写任何东西。
func show(sample: URL) -> Int32 {
    guard let app = currentApp(for: sample) else {
        print("（没有默认应用：\(sample.path)）")
        return 0
    }
    print(app.path)
    if let bundle = Bundle(url: app), let id = bundle.bundleIdentifier {
        print("bundle-id: \(id)")
    } else {
        print("bundle-id: （读不到）")
    }
    return 0
}

/// 设置 + 读回核对。
func set(appPath: String, sample: URL) -> Int32 {
    let app = URL(fileURLWithPath: appPath)
    guard FileManager.default.fileExists(atPath: app.path) else {
        die("⛔ 目标应用不存在：\(app.path)")
    }
    guard FileManager.default.fileExists(atPath: sample.path) else {
        die("⛔ 样本文件不存在：\(sample.path)")
    }

    let before = currentApp(for: sample)?.path ?? "（无）"

    // ⚠️⚠️ 这个 API 是**异步**的（2026-10-19 实测）：头文件的原形是
    //    `…toOpenContentTypeOfFileAtURL:completionHandler:`，Swift 把那个可空 block
    //    收成一个可省略的尾随闭包 ⇒ **不写闭包也能编译**，而且**立刻返回**。
    //    ⛔ 不等回调就读回来 = 永远读到旧值（第一版就是这样"设置成功"了一个假象）。
    //    ⭐ 还有一条来自头文件的警告：某些类型**需要用户同意**，系统会先弹框、
    //    弹完才调 completion —— 所以这里的超时给得比"立刻"宽。
    var finished = false
    var failure: Error?
    NSWorkspace.shared.setDefaultApplication(at: app, toOpenContentTypeOfFileAt: sample) { error in
        failure = error
        finished = true
    }
    let deadline = Date().addingTimeInterval(30)
    while !finished && Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
    if let failure {
        die("⛔ 设置默认应用失败：\(failure.localizedDescription)")
    }
    if !finished {
        die("⛔ 30 s 内没有收到系统的设置结果（是不是有确认框没点？）")
    }

    // ⚠️ **必须读回核对**：这个 API 会"成功返回但什么也没变"（LaunchServices 的
    //    登记过期、或目标 app 没被 lsregister 认出来时就是这样）。
    //    ⛔ 只看"没报错"就是一份假的成功。
    //    ⚠️ 回调返回后改动可能还要一小会儿才可见 ⇒ 轮询 3 s，⛔ 不是读一次就判死。
    var after = currentApp(for: sample)?.path ?? "（无）"
    let until = Date().addingTimeInterval(3)
    while Date() < until {
        let want = app.resolvingSymlinksInPath().path
        let got = URL(fileURLWithPath: after).resolvingSymlinksInPath().path
        if got == want { break }
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
        after = currentApp(for: sample)?.path ?? "（无）"
    }
    print("改前：\(before)")
    print("改后：\(after)")

    // 比较**真实路径**（/private/var 与 /var 这类符号链接差异不算失败）。
    let want = app.resolvingSymlinksInPath().path
    let got = URL(fileURLWithPath: after).resolvingSymlinksInPath().path
    if got != want {
        die("⛔ 读回来不是目标应用（期望 \(want)，实际 \(got)）——多半是没 lsregister 或那个 .app 不完整", 2)
    }
    return 0
}

let args = CommandLine.arguments
guard args.count >= 3 else {
    die("""
    用法：
      set-default-app.swift --show <样本.md>
      set-default-app.swift --set <目标.app> <样本.md>
    """)
}

switch args[1] {
case "--show":
    exit(show(sample: URL(fileURLWithPath: args[2])))
case "--set":
    guard args.count >= 4 else { die("--set 需要两个参数：<目标.app> <样本.md>") }
    exit(set(appPath: args[2], sample: URL(fileURLWithPath: args[3])))
default:
    die("⛔ 不认识的模式：\(args[1])（只支持 --show / --set）")
}
