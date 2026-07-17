/*
 * MainWindow.xaml.cs — the shell's behaviour.
 *
 * Loads the project through nexia-core, opens files in the editor, saves them,
 * and drives a build on a background thread so the window stays responsive.
 */
using System;
using System.IO;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;

namespace NexiaUI
{
    public partial class MainWindow : Window
    {
        // The real test project.
        const string kProject = @"C:\Users\mrtit\Documents\NexiaIDE\Projects\CaveGame2";

        string _openPath;   // file currently in the editor, null if none
        bool _building;

        public MainWindow()
        {
            InitializeComponent();
            LoadProject();
        }

        void LoadProject()
        {
            SdkText.Text = CoreBridge.DetectSdk();
            string name, real;
            CoreBridge.OpenProject(kProject, out name, out real);
            ProjText.Text = name;
            Tree.ItemsSource = CoreBridge.ProjectTree(kProject);
            Append("Nexia IDE (WPF) — loaded through nexia-core.\n");
        }

        void OnTreeSelect(object sender, RoutedPropertyChangedEventArgs<object> e)
        {
            var node = e.NewValue as FileNode;
            if (node == null || node.IsDirectory) return;
            try
            {
                Editor.Text = File.ReadAllText(node.Path);
                _openPath = node.Path;
                EditorHeader.Text = "EDITOR  —  " + node.Name;
            }
            catch (Exception ex) { Append("Could not open " + node.Name + ": " + ex.Message + "\n"); }
        }

        void OnSave(object sender, RoutedEventArgs e)
        {
            if (_openPath == null) return;
            try { File.WriteAllText(_openPath, Editor.Text); StatusText.Text = "saved"; }
            catch (Exception ex) { Append("Save failed: " + ex.Message + "\n"); }
        }

        void OnReload(object sender, RoutedEventArgs e) { LoadProject(); }
        void OnExit(object sender, RoutedEventArgs e) { Close(); }

        void OnBuild(object sender, RoutedEventArgs e)
        {
            if (_building) return;
            _building = true;
            StatusText.Text = "building…";
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

        void Append(string s)
        {
            Output.AppendText(s);
            Output.ScrollToEnd();
        }

        protected override void OnPreviewKeyDown(KeyEventArgs e)
        {
            base.OnPreviewKeyDown(e);
            if (e.Key == Key.S && (Keyboard.Modifiers & ModifierKeys.Control) != 0) { OnSave(this, null); e.Handled = true; }
            else if (e.Key == Key.F7) { OnBuild(this, null); e.Handled = true; }
        }
    }
}
