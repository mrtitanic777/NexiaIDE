/*
 * FileNode.cs — one node of the Solution Explorer tree, bound to a WPF TreeView
 * through a HierarchicalDataTemplate. Built from nexia-core's `project tree`.
 */
using System.Collections.Generic;
using System.Collections.ObjectModel;

namespace NexiaUI
{
    public class FileNode
    {
        public string Name { get; set; }
        public string Path { get; set; }
        public bool IsDirectory { get; set; }
        public ObservableCollection<FileNode> Children { get; set; }

        public FileNode() { Children = new ObservableCollection<FileNode>(); }

        // Recursively build FileNodes from the object[] nexia-core returns.
        public static void FromJsonArray(object[] arr, IList<FileNode> into)
        {
            foreach (var item in arr)
            {
                var d = item as Dictionary<string, object>;
                if (d == null) continue;
                var n = new FileNode
                {
                    Name = CoreBridge.Str(d, "name"),
                    Path = CoreBridge.Str(d, "path"),
                    IsDirectory = CoreBridge.Get(d, "isDirectory") is bool && (bool)d["isDirectory"],
                };
                var kids = CoreBridge.Get(d, "children") as object[];
                if (kids != null) FromJsonArray(kids, n.Children);
                into.Add(n);
            }
        }
    }
}
