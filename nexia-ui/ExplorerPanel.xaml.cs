using System;
using System.Collections.Generic;
using System.Windows.Controls;

namespace NexiaUI
{
    public partial class ExplorerPanel : UserControl
    {
        // Raised when a file (not a folder) is selected.
        public Action<FileNode> FileOpened;

        public ExplorerPanel() { InitializeComponent(); }

        public void Load(IEnumerable<FileNode> roots) { Tree.ItemsSource = roots; }

        void OnSelect(object sender, System.Windows.RoutedPropertyChangedEventArgs<object> e)
        {
            var n = e.NewValue as FileNode;
            if (n != null && !n.IsDirectory && FileOpened != null) FileOpened(n);
        }
    }
}
