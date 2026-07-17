/*
 * GitPanel.xaml.cs — Source Control.
 *
 * Shows the project's branch, changed files and recent log, and can stage-all +
 * commit, or init the repo when there isn't one yet. Clicking a change opens it
 * in the editor.
 */
using System;
using System.Windows;
using System.Windows.Controls;

namespace NexiaUI
{
    public partial class GitPanel : UserControl
    {
        public string RepoDir;
        public Action<string> OpenFile;   // open a repo-relative path
        public Action<string> Log;        // write a line to the Output pane

        public GitPanel() { InitializeComponent(); Loaded += (s, e) => Refresh(); }

        public void Refresh()
        {
            if (string.IsNullOrEmpty(RepoDir)) return;
            bool repo = GitService.IsRepo(RepoDir);
            NoRepo.Visibility = repo ? Visibility.Collapsed : Visibility.Visible;
            CommitBox.Visibility = repo ? Visibility.Visible : Visibility.Collapsed;
            if (!repo) { BranchText.Text = ""; Changes.ItemsSource = null; LogText.Text = ""; return; }

            BranchText.Text = "on " + GitService.Branch(RepoDir);
            Changes.ItemsSource = GitService.Status(RepoDir);
            LogText.Text = GitService.Log(RepoDir, 15);
        }

        void OnRefresh(object sender, RoutedEventArgs e) { Refresh(); }

        void OnInit(object sender, RoutedEventArgs e)
        {
            if (Log != null) Log("git: " + GitService.Init(RepoDir).Trim() + "\n");
            Refresh();
        }

        void OnCommit(object sender, RoutedEventArgs e)
        {
            string msg = Message.Text.Trim();
            if (msg.Length == 0) { if (Log != null) Log("git: enter a commit message first.\n"); return; }
            GitService.StageAll(RepoDir);
            string outp;
            GitService.Commit(RepoDir, msg, out outp);
            if (Log != null) Log("git commit:\n" + outp.Trim() + "\n");
            Message.Text = "";
            Refresh();
        }

        void OnPickFile(object sender, SelectionChangedEventArgs e)
        {
            var f = Changes.SelectedItem as GitFile;
            if (f == null || OpenFile == null) return;
            string full = System.IO.Path.Combine(RepoDir, f.Path.Replace('/', '\\'));
            if (System.IO.File.Exists(full)) OpenFile(full);
        }
    }
}
