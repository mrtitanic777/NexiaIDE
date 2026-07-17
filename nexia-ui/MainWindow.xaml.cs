/*
 * MainWindow.xaml.cs — the IDE shell.
 *
 * Owns the activity rail, the sidebar panels, the editor, the bottom panel and
 * the menu. The Explorer panel is real (the file tree from nexia-core); the other
 * rail panels are titled stubs for now, each naming what it will hold, and get
 * fleshed out one at a time. Every backend touch goes through nexia-core.
 */
using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;

namespace NexiaUI
{
    public partial class MainWindow : Window
    {
        const string kProject = @"C:\Users\mrtit\Documents\NexiaIDE\Projects\CaveGame2";

        ExplorerPanel _explorer;
        readonly Dictionary<string, UserControl> _panels = new Dictionary<string, UserControl>();
        string _openPath;
        bool _building;

        public MainWindow()
        {
            InitializeComponent();
            BuildPanels();
            LoadProject();
            ShowPanel("explorer");
            TipText.Text = "Press F7 to build. Click a file in the Solution Explorer to open it. "
                         + "The rail on the left switches panels — each is being ported from the Electron IDE.";
        }

        // ── the rail panels ──
        void BuildPanels()
        {
            _explorer = new ExplorerPanel { FileOpened = OpenFile };
            _panels["explorer"]   = _explorer;
            _panels["search"]     = new SearchPanel { ProjectPath = kProject, OpenAt = OpenFileAt };
            _panels["ai"]         = new StubPanel("AI TUTOR", "Multi-provider assistant (Anthropic, OpenAI, Ollama): streaming chat, code generation, inline explain / fix / refactor, and proactive tutoring.");
            _panels["git"]        = new GitPanel { RepoDir = kProject, OpenFile = OpenFileByPath, Log = Append };
            _panels["extensions"] = new StubPanel("EXTENSIONS", "Install community tools, templates, snippet packs, themes and plugins from .zip files or folders.");
            _panels["devkit"]     = new StubPanel("DEVKIT", "Connect to a dev kit over the network: deploy builds, reboot, screenshot, browse the file system, watch CPU/memory.");
            _panels["emulator"]   = new StubPanel("EMULATOR (Nexia 360)", "Launch and debug builds: breakpoints, registers, step, read/write memory, backtraces.");
            _panels["learn"]      = new StubPanel("LEARN", "The cinematic lesson system: 17 lessons across 8 modules, typing animations, mastery tracking, quizzes, flashcards, and cloud lessons.");
            _panels["community"]  = new StubPanel("COMMUNITY", "The built-in Discord feed: browse threads, post questions, share downloads.");
        }

        void ShowPanel(string key)
        {
            UserControl p;
            if (_panels.TryGetValue(key, out p)) SidebarHost.Content = p;
        }

        void OnRail(object sender, RoutedEventArgs e)
        {
            if (SidebarHost == null) return; // during init
            var rb = sender as RadioButton;
            if (rb == RbExplorer) ShowPanel("explorer");
            else if (rb == RbSearch) ShowPanel("search");
            else if (rb == RbAi) ShowPanel("ai");
            else if (rb == RbGit) ShowPanel("git");
            else if (rb == RbExtensions) ShowPanel("extensions");
            else if (rb == RbDevkit) ShowPanel("devkit");
            else if (rb == RbEmulator) ShowPanel("emulator");
            else if (rb == RbLearn) ShowPanel("learn");
            else if (rb == RbCommunity) ShowPanel("community");
        }

        void SelectRail(RadioButton rb) { rb.IsChecked = true; }

        // ── project + editor ──
        void LoadProject()
        {
            SdkText.Text = CoreBridge.DetectSdk();
            string name, real;
            CoreBridge.OpenProject(kProject, out name, out real);
            ProjText.Text = name;
            _explorer.Load(CoreBridge.ProjectTree(kProject));
        }

        void OpenFile(FileNode node) { OpenFileByPath(node.Path); }

        void OpenFileByPath(string path)
        {
            try
            {
                Editor.Text = File.ReadAllText(path);
                _openPath = path;
                EditorHeader.Text = Path.GetFileName(path);
            }
            catch (Exception ex) { Append("Could not open " + Path.GetFileName(path) + ": " + ex.Message + "\n"); }
        }

        // Open a file and jump the editor to a 1-based line (from a search hit).
        void OpenFileAt(string path, int line)
        {
            OpenFileByPath(path);
            int idx = line - 1;
            if (idx >= 0 && idx < Editor.LineCount)
            {
                int start = Editor.GetCharacterIndexFromLineIndex(idx);
                int len = Editor.GetLineLength(idx);
                Editor.Select(start, Math.Max(0, len));
                Editor.ScrollToLine(idx);
                Editor.Focus();
            }
        }

        // ── menu handlers ──
        void OnSave(object sender, RoutedEventArgs e)
        {
            if (_openPath == null) return;
            try { File.WriteAllText(_openPath, Editor.Text); StatusText.Text = "saved " + Path.GetFileName(_openPath); }
            catch (Exception ex) { Append("Save failed: " + ex.Message + "\n"); }
        }

        void OnCloseProject(object sender, RoutedEventArgs e)
        {
            _explorer.Load(new List<FileNode>());
            Editor.Text = ""; _openPath = null; EditorHeader.Text = "No file open";
            ProjText.Text = "(none)";
            Append("Project closed.\n");
        }

        void OnNewProject(object sender, RoutedEventArgs e) { Append("New Project dialog — coming.\n"); }
        void OnOpenProject(object sender, RoutedEventArgs e) { Append("Open Project dialog — coming.\n"); }
        void OnFindInFiles(object sender, RoutedEventArgs e) { SelectRail(RbSearch); }
        void OnViewExplorer(object sender, RoutedEventArgs e) { SelectRail(RbExplorer); }
        void OnViewOutput(object sender, RoutedEventArgs e) { BottomTabs.SelectedIndex = 0; }
        void OnClean(object sender, RoutedEventArgs e) { Append("Clean — coming.\n"); }
        void OnProjectProps(object sender, RoutedEventArgs e) { Append("Project Properties — coming.\n"); }
        void OnShowDevkit(object sender, RoutedEventArgs e) { SelectRail(RbDevkit); }
        void OnShowEmulator(object sender, RoutedEventArgs e) { SelectRail(RbEmulator); }
        void OnShowExtensions(object sender, RoutedEventArgs e) { SelectRail(RbExtensions); }
        void OnXexInspector(object sender, RoutedEventArgs e) { Append("XEX Inspector — coming.\n"); }
        void OnExit(object sender, RoutedEventArgs e) { Close(); }
        void OnAbout(object sender, RoutedEventArgs e)
        {
            MessageBox.Show(this, "Nexia IDE — native UI (WPF).\nStanding on nexia-core, the ported C backend.",
                            "About Nexia IDE", MessageBoxButton.OK, MessageBoxImage.Information);
        }

        // ── build ──
        void OnBuild(object sender, RoutedEventArgs e)
        {
            if (_building) return;
            _building = true;
            StatusText.Text = "building…";
            BottomTabs.SelectedIndex = 0;
            Append("\n");
            Task.Run(() =>
            {
                bool ok = Builder.Build(kProject, "Debug",
                    s => Dispatcher.BeginInvoke(new Action(() => Append(s))));
                Dispatcher.BeginInvoke(new Action(() =>
                {
                    _building = false;
                    StatusText.Text = ok ? "build succeeded" : "build failed";
                }));
            });
        }

        void Append(string s) { Output.AppendText(s); Output.ScrollToEnd(); }

        protected override void OnPreviewKeyDown(KeyEventArgs e)
        {
            base.OnPreviewKeyDown(e);
            if (e.Key == Key.S && (Keyboard.Modifiers & ModifierKeys.Control) != 0) { OnSave(this, null); e.Handled = true; }
            else if (e.Key == Key.F7) { OnBuild(this, null); e.Handled = true; }
        }
    }
}
