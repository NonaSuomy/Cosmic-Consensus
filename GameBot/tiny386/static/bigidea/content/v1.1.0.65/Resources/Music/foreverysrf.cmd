@echo off
cls

for %%f in (*.srf) do (
	echo.
	echo Now it is time for %%f
	echo.
	srfextra.exe %%f
)

