property serverPid : missing value

on run
	set appRoot to POSIX path of (path to me)
	set launcherPath to appRoot & "Contents/Resources/launcher.py"
	set sitePath to appRoot & "Contents/Resources/site"
	set logPath to "/tmp/remote-spades-table.log"
	set launchCommand to "/usr/bin/python3 " & quoted form of launcherPath & " " & quoted form of sitePath & " >> " & quoted form of logPath & " 2>&1 & echo $!"
	set serverPid to do shell script launchCommand
	display notification "Opening your Spades table in the browser." with title "Remote Spades"
end run

on quit
	if serverPid is not missing value then
		do shell script "/bin/kill " & serverPid & " >/dev/null 2>&1 || true"
	end if
	continue quit
end quit
