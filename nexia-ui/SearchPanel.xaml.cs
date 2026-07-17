/*
 * SearchPanel.xaml.cs — Find in Files.
 *
 * Walks the project's text files and lists every line containing the query,
 * click-to-open. Searching the working copy is generic file work, so it runs in
 * C# directly rather than through nexia-core, off the UI thread so a big project
 * does not freeze the window.
 */
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Controls;
using System.Windows.Input;

namespace NexiaUI
{
    public class SearchHit
    {
        public string File { get; set; }
        public int Line { get; set; }
        public string Preview { get; set; }
        public string Path { get; set; }
    }

    public partial class SearchPanel : UserControl
    {
        // Set by the shell.
        public string ProjectPath;
        public Action<string, int> OpenAt;   // (path, 1-based line)

        static readonly HashSet<string> TextExt = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        { ".cpp", ".c", ".cc", ".cxx", ".h", ".hpp", ".hxx", ".inl", ".txt", ".json", ".xml",
          ".hlsl", ".fx", ".cs", ".md", ".ini", ".cfg", ".rc", ".nexproj" };

        public SearchPanel() { InitializeComponent(); }

        void OnQueryKey(object sender, KeyEventArgs e) { if (e.Key == Key.Enter) OnFind(null, null); }

        async void OnFind(object sender, System.Windows.RoutedEventArgs e)
        {
            string q = Query.Text;
            if (string.IsNullOrEmpty(q) || string.IsNullOrEmpty(ProjectPath)) return;
            Summary.Text = "Searching…";
            Results.ItemsSource = null;

            var hits = await Task.Run(() => Run(ProjectPath, q));
            Results.ItemsSource = hits;
            Summary.Text = hits.Count + " result" + (hits.Count == 1 ? "" : "s")
                         + " in " + CountFiles(hits) + " file" + (CountFiles(hits) == 1 ? "" : "s");
        }

        static int CountFiles(IEnumerable<SearchHit> hits)
        {
            var s = new HashSet<string>();
            foreach (var h in hits) s.Add(h.Path);
            return s.Count;
        }

        static ObservableCollection<SearchHit> Run(string root, string query)
        {
            var outp = new ObservableCollection<SearchHit>();
            IEnumerable<string> files;
            try { files = Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories); }
            catch { return outp; }

            foreach (var path in files)
            {
                // skip build output and non-text files
                if (path.IndexOf("\\out\\", StringComparison.OrdinalIgnoreCase) >= 0) continue;
                if (!TextExt.Contains(Path.GetExtension(path))) continue;

                string[] lines;
                try { lines = File.ReadAllLines(path); } catch { continue; }
                string name = Path.GetFileName(path);
                for (int i = 0; i < lines.Length; i++)
                {
                    if (lines[i].IndexOf(query, StringComparison.OrdinalIgnoreCase) < 0) continue;
                    outp.Add(new SearchHit
                    {
                        File = name,
                        Line = i + 1,
                        Preview = lines[i].Trim(),
                        Path = path,
                    });
                    if (outp.Count > 2000) return outp; // sanity cap
                }
            }
            return outp;
        }

        void OnPick(object sender, SelectionChangedEventArgs e)
        {
            var hit = Results.SelectedItem as SearchHit;
            if (hit != null && OpenAt != null) OpenAt(hit.Path, hit.Line);
        }
    }
}
