using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

class NativeHost {
    const string Origin = "chrome-extension://ioakbhlnnjbcmcndpgllclgjpjnohaoc/";
    static JavaScriptSerializer Json = new JavaScriptSerializer();
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct StartupInfo {
        public int cb; public string reserved; public string desktop; public string title;
        public int x,y,xSize,ySize,xChars,yChars,fill,flags; public short show,reserved2;
        public IntPtr reservedPointer,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr process,thread; public int processId,threadId; }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    static extern bool CreateProcess(string app, StringBuilder command, IntPtr processSecurity,
        IntPtr threadSecurity, bool inheritHandles, uint flags, IntPtr environment,
        string directory, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static void StartDetached(string python,string server,string directory) {
        var startup=new StartupInfo(); startup.cb=Marshal.SizeOf(startup);
        ProcessInfo process;
        // Inheriting Chrome's native-message pipe keeps the host connection open.
        // Launch with no inherited handles and no console.
        if(!CreateProcess(python,new StringBuilder("\""+python+"\" -X utf8 \""+server+"\" --background"),
            IntPtr.Zero,IntPtr.Zero,false,0x08000200,IntPtr.Zero,directory,ref startup,out process))
            throw new Exception("Service launch failed: "+Marshal.GetLastWin32Error());
        CloseHandle(process.thread); CloseHandle(process.process);
    }
    static byte[] ReadBytes(Stream stream, int length) {
        byte[] result = new byte[length];
        int offset = 0;
        while (offset < length) {
            int count = stream.Read(result, offset, length-offset);
            if (count == 0) throw new IOException("Native request ended early");
            offset += count;
        }
        return result;
    }
    static bool Healthy() {
        try {
            var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:8765/health");
            request.Timeout = 600; request.Proxy = null;
            using (var response = request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream())) {
                var data = Json.Deserialize<Dictionary<string,object>>(reader.ReadToEnd());
                return data.ContainsKey("app") && (string)data["app"] == "video-subtitle-assistant"
                    && data.ContainsKey("version") && (string)data["version"] == "0.3.0";
            }
        } catch { return false; }
    }
    static void Reply(object result) {
        byte[] data = Encoding.UTF8.GetBytes(Json.Serialize(result));
        var output = Console.OpenStandardOutput();
        byte[] size = BitConverter.GetBytes(data.Length);
        output.Write(size,0,size.Length); output.Write(data,0,data.Length); output.Flush();
    }
    static void Main(string[] args) {
        try {
            if (args.Length < 1 || args[0] != Origin) throw new Exception("Extension origin rejected");
            var input = Console.OpenStandardInput();
            int length = BitConverter.ToInt32(ReadBytes(input,4),0);
            if (length < 2 || length > 4096) throw new Exception("Invalid native request");
            var message = Json.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(ReadBytes(input,length)));
            if (!message.ContainsKey("action") || (string)message["action"] != "ensure_service")
                throw new Exception("Unsupported action");
            if (!Healthy()) {
                string folder = AppDomain.CurrentDomain.BaseDirectory;
                var config = Json.Deserialize<Dictionary<string,string>>(File.ReadAllText(Path.Combine(folder,"host_config.json"),Encoding.UTF8));
                StartDetached(config["python"],config["server"],folder);
                bool ready = false;
                for (int i=0;i<120;i++) {
                    if (Healthy()) { ready=true; break; }
                    Thread.Sleep(100);
                }
                if (!ready) throw new Exception("Local speech service did not start; run the repair launcher");
            }
            Reply(new {ok=true,version="0.3.0"});
        } catch (Exception error) {
            Reply(new {ok=false,error=error.Message});
        }
    }
}
