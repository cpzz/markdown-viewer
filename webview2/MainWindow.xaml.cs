using Microsoft.UI.Composition.SystemBackdrops;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.Web.WebView2.Core;

namespace MarkdownViewer;

public sealed partial class MainWindow : Window
{
    private readonly bool _devMode;

    public MainWindow(string[] args)
    {
        _devMode = args.Contains("--dev") || args.Contains("-d");

        InitializeComponent();

        Title = "Markdown Viewer";
        ExtendsContentIntoTitleBar = true;
        AppWindow.Resize(new Windows.Graphics.SizeInt32(1200, 800));
        ((OverlappedPresenter)AppWindow.Presenter).Maximize();
        AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "logo.ico"));

        SetMicaBackdrop();

        RootGrid.Loaded += OnLoaded;
    }

    private void SetMicaBackdrop()
    {
        if (MicaController.IsSupported())
        {
            SystemBackdrop = new MicaBackdrop();
        }
        else if (DesktopAcrylicController.IsSupported())
        {
            SystemBackdrop = new DesktopAcrylicBackdrop();
        }
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        try
        {
            await WebView.EnsureCoreWebView2Async();

            WebView.AllowDrop = true;

            WebView.CoreWebView2.Profile.PreferredColorScheme = CoreWebView2PreferredColorScheme.Auto;

            if (_devMode)
            {
                WebView.CoreWebView2.Settings.AreDevToolsEnabled = true;
                WebView.CoreWebView2.Navigate("http://localhost:5173/?webview2=1");
                return;
            }

            var distPath = FindDistPath();

            if (!Directory.Exists(distPath) || !Directory.EnumerateFileSystemEntries(distPath).Any())
            {
                await ShowErrorDialog($"未找到 dist 目录：\n{distPath}\n\n请先运行 npm run build");
                return;
            }

            WebView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                "local.markdownviewer",
                distPath,
                CoreWebView2HostResourceAccessKind.Allow);

            WebView.CoreWebView2.Navigate("https://local.markdownviewer/index.html?webview2=1");
        }
        catch (Exception ex)
        {
            await ShowErrorDialog($"初始化 WebView2 失败：\n{ex.Message}\n\n请确保已安装 WebView2 Runtime（Win10/11 通常已预装）");
        }
    }

    private async Task ShowErrorDialog(string message)
    {
        var dialog = new ContentDialog
        {
            Title = "Markdown Viewer",
            Content = message,
            CloseButtonText = "OK",
            XamlRoot = Content.XamlRoot
        };
        await dialog.ShowAsync();
    }

    private static string FindDistPath()
    {
        var baseDirDist = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "dist"));
        if (Directory.Exists(baseDirDist)) return baseDirDist;

        var cwdDist = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), "dist"));
        if (Directory.Exists(cwdDist)) return cwdDist;

        return baseDirDist;
    }
}