//go:build darwin && cgo

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

@interface RTX5WindowDelegate : NSObject <NSWindowDelegate>
@end

@implementation RTX5WindowDelegate
- (void)windowWillClose:(NSNotification *)notification {
    [NSApp terminate:nil];
}
@end

void rtx5_run_macos_webview(const char* urlStr, const char* titleStr) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];

        NSRect frame = NSMakeRect(0, 0, 1400, 900);
        NSWindowStyleMask style = NSWindowStyleMaskTitled |
                                  NSWindowStyleMaskClosable |
                                  NSWindowStyleMaskMiniaturizable |
                                  NSWindowStyleMaskResizable;

        NSWindow *window = [[NSWindow alloc] initWithContentRect:frame
                                                       styleMask:style
                                                         backing:NSBackingStoreBuffered
                                                           defer:NO];
        NSString *title = [NSString stringWithUTF8String:titleStr ? titleStr : "RTX5 Desktop"];
        [window setTitle:title];
        [window center];

        RTX5WindowDelegate *delegate = [[RTX5WindowDelegate alloc] init];
        [window setDelegate:delegate];

        WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
        WKWebView *webView = [[WKWebView alloc] initWithFrame:[[window contentView] bounds]
                                                configuration:config];
        [webView setAutoresizingMask:(NSViewWidthSizable | NSViewHeightSizable)];
        [[window contentView] addSubview:webView];

        NSString *nsURL = [NSString stringWithUTF8String:urlStr ? urlStr : "about:blank"];
        NSURL *url = [NSURL URLWithString:nsURL];
        if (url != nil) {
            [webView loadRequest:[NSURLRequest requestWithURL:url]];
        }

        [window makeKeyAndOrderFront:nil];
        [window zoom:nil];
        [NSApp activateIgnoringOtherApps:YES];
        [NSApp run];
    }
}

void rtx5_quit_macos_webview(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        [NSApp terminate:nil];
    });
}
