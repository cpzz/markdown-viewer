using Microsoft.UI.Xaml;

namespace MarkdownViewer;

public partial class App : Application
{
    private readonly string[] _args;

    public App()
    {
        _args = Environment.GetCommandLineArgs().Skip(1).ToArray();
        InitializeComponent();
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        MainWindow = new MainWindow(_args);
        MainWindow.Activate();
    }

    public MainWindow MainWindow { get; private set; } = null!;
}