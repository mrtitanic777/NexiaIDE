using System.Windows.Controls;

namespace NexiaUI
{
    // A titled placeholder for a panel that is present in the shell but whose
    // content is still being ported from the Electron renderer. The body names
    // what the panel will hold, so the frame itself shows the remaining scope.
    public partial class StubPanel : UserControl
    {
        public StubPanel(string title, string body)
        {
            InitializeComponent();
            TitleText.Text = title;
            BodyText.Text = body;
        }
    }
}
